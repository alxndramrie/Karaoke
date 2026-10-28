
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { supabase, configured } from "./supabase";
import SongLibrary from "./SongLibrary.jsx";

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const randomId = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    (n) => n.toString(16).padStart(2, "0")
  ).join("");

const initial = new URLSearchParams(window.location.search);

// ==================================================
// KARAOKE ROOM - SUPABASE + WEBRTC
// ==================================================

function useKaraokeRoom(role, room) {
  const [status, setStatus] = useState("Connecting to room...");
  const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [singers, setSingers] = useState([]);

  const peersRef = useRef(new Map());
  const phonePeerRef = useRef(null);
  const channelRef = useRef(null);
  const micStreamRef = useRef(null);
  const subscribedRef = useRef(false);
  const selfIdRef = useRef(randomId());
  const nameRef = useRef("Singer");
  const liveRef = useRef(false);

  const send = (message) => {
    return channelRef.current?.send({
      type: "broadcast",
      event: "signal",
      payload: {
        ...message,
        from: selfIdRef.current,
      },
    });
  };

  const refreshSingers = () => {
    setSingers(
      Array.from(peersRef.current.entries()).map(([id, peer]) => ({
        id,
        name: peer.name,
        stream: peer.stream,
        connected: peer.pc.connectionState === "connected",
      }))
    );
  };

  const removeSinger = (id) => {
    const peer = peersRef.current.get(id);
    if (!peer) return;

    peersRef.current.delete(id);
    peer.pc.close();
    refreshSingers();
  };

  const closePhonePeer = () => {
    const current = phonePeerRef.current;
    phonePeerRef.current = null;

    current?.pc.close();
    setConnected(false);
  };

  const flushIce = async (entry) => {
    for (const ice of entry.pendingIce.splice(0)) {
      try {
        await entry.pc.addIceCandidate(ice);
      } catch (error) {
        console.warn("ICE rejected:", error);
      }
    }
  };

  // ==================================================
  // HOST - CREATE A CONNECTION FOR EACH PHONE
  // ==================================================

  const createHostOffer = async (phoneId, name) => {
    if (peersRef.current.has(phoneId)) return;

    const pc = new RTCPeerConnection(rtcConfig);
    const session = randomId();

    const entry = {
      pc,
      session,
      pendingIce: [],
      name: name || "Singer",
      stream: null,
    };

    peersRef.current.set(phoneId, entry);
    refreshSingers();

    pc.onicecandidate = (event) => {
      if (
        event.candidate &&
        peersRef.current.get(phoneId) === entry
      ) {
        send({
          type: "ice",
          to: phoneId,
          session,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      if (peersRef.current.get(phoneId) !== entry) return;

      entry.stream =
        event.streams[0] || new MediaStream([event.track]);

      refreshSingers();
    };

    pc.onconnectionstatechange = () => {
      if (peersRef.current.get(phoneId) !== entry) return;

      refreshSingers();

      if (["failed", "closed"].includes(pc.connectionState)) {
        removeSinger(phoneId);
      }
    };

    try {
      pc.addTransceiver("audio", {
        direction: "recvonly",
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await send({
        type: "offer",
        to: phoneId,
        session,
        sdp: pc.localDescription.toJSON(),
      });

      setStatus("Waiting for singers to connect...");
    } catch (error) {
      removeSinger(phoneId);
      setStatus("Offer error: " + error.message);
    }
  };

  // ==================================================
  // HANDLE SIGNALING
  // ==================================================

  const handleSignal = async (payload) => {
    if (
      !payload ||
      payload.from === selfIdRef.current ||
      !liveRef.current
    ) {
      return;
    }

    if (payload.to && payload.to !== selfIdRef.current) {
      return;
    }

    if (role === "host") {
      if (payload.type === "join") {
        await createHostOffer(payload.from, payload.name);
      }

      if (payload.type === "leave") {
        removeSinger(payload.from);
      }

      if (payload.type === "answer") {
        const entry = peersRef.current.get(payload.from);

        if (
          !entry ||
          entry.session !== payload.session ||
          entry.pc.signalingState !== "have-local-offer"
        ) {
          return;
        }

        await entry.pc.setRemoteDescription(payload.sdp);
        await flushIce(entry);
      }

      if (payload.type === "ice" && payload.candidate) {
        const entry = peersRef.current.get(payload.from);

        if (!entry || entry.session !== payload.session) {
          return;
        }

        if (entry.pc.remoteDescription) {
          await entry.pc.addIceCandidate(payload.candidate);
        } else {
          entry.pendingIce.push(payload.candidate);
        }
      }
    } else {
      // Phone receives an offer from the host.
      if (payload.type === "offer" && micStreamRef.current) {
        if (phonePeerRef.current?.session === payload.session) {
          return;
        }

        closePhonePeer();

        const pc = new RTCPeerConnection(rtcConfig);

        const entry = {
          pc,
          session: payload.session,
          pendingIce: [],
          hostId: payload.from,
        };

        phonePeerRef.current = entry;

        pc.onicecandidate = (event) => {
          if (
            event.candidate &&
            phonePeerRef.current === entry
          ) {
            send({
              type: "ice",
              to: entry.hostId,
              session: entry.session,
              candidate: event.candidate.toJSON(),
            });
          }
        };

        pc.onconnectionstatechange = () => {
          if (phonePeerRef.current !== entry) return;

          const isConnected =
            pc.connectionState === "connected";

          setConnected(isConnected);

          if (isConnected) {
            setStatus("Connected! Your phone is a microphone.");
          }

          if (
            ["failed", "closed"].includes(pc.connectionState)
          ) {
            closePhonePeer();
            setStatus("Connection lost. Trying to reconnect...");
          }
        };

        await pc.setRemoteDescription(payload.sdp);

        micStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, micStreamRef.current);
        });

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await send({
          type: "answer",
          to: entry.hostId,
          session: entry.session,
          sdp: pc.localDescription.toJSON(),
        });

        await flushIce(entry);
        setStatus("Connecting audio...");
      }

      if (payload.type === "ice" && payload.candidate) {
        const entry = phonePeerRef.current;

        if (
          !entry ||
          entry.session !== payload.session ||
          entry.hostId !== payload.from
        ) {
          return;
        }

        if (entry.pc.remoteDescription) {
          await entry.pc.addIceCandidate(payload.candidate);
        } else {
          entry.pendingIce.push(payload.candidate);
        }
      }
    }
  };

  const handleRef = useRef(null);
  handleRef.current = handleSignal;

  // ==================================================
  // CONNECT TO SUPABASE ROOM
  // ==================================================

  useEffect(() => {
    if (!configured || !room) return;

    liveRef.current = true;

    const channel = supabase.channel(`karaoke-${room}`, {
      config: {
        private: false,
        broadcast: { ack: true },
      },
    });

    channelRef.current = channel;

    channel.on(
      "broadcast",
      { event: "signal" },
      ({ payload }) => {
        Promise.resolve(handleRef.current?.(payload)).catch(
          (error) => {
            setStatus("Connection error: " + error.message);
          }
        );
      }
    );

    channel.subscribe((state) => {
      if (!liveRef.current) return;

      if (state === "SUBSCRIBED") {
        subscribedRef.current = true;

        setStatus(
          role === "host"
            ? "Ready! Invite singers using the QR code."
            : "Ready! Enable your microphone."
        );

        if (role === "mic" && micStreamRef.current) {
          send({
            type: "join",
            name: nameRef.current,
          });
        }
      }

      if (
        state === "CHANNEL_ERROR" ||
        state === "TIMED_OUT"
      ) {
        subscribedRef.current = false;
        setStatus("Supabase connection error.");
      }
    });

    const interval = setInterval(() => {
      if (
        role === "mic" &&
        subscribedRef.current &&
        micStreamRef.current &&
        !phonePeerRef.current
      ) {
        send({
          type: "join",
          name: nameRef.current,
        });
      }
    }, 3000);

    return () => {
      liveRef.current = false;

      if (role === "mic" && subscribedRef.current) {
        send({ type: "leave" });
      }

      subscribedRef.current = false;
      clearInterval(interval);

      supabase.removeChannel(channel);

      if (channelRef.current === channel) {
        channelRef.current = null;
      }

      peersRef.current.forEach((entry) => entry.pc.close());
      peersRef.current.clear();

      closePhonePeer();

      micStreamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());

      micStreamRef.current = null;
    };
  }, [room, role]);

  // ==================================================
  // PHONE MICROPHONE CONTROLS
  // ==================================================

  const toggleMic = async (name) => {
    nameRef.current =
      (name || "Singer").trim().slice(0, 24) || "Singer";

    if (!micStreamRef.current) {
      try {
        setStatus("Requesting microphone permission...");

        micStreamRef.current =
          await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
            },
            video: false,
          });

        setMicOn(true);
        setStatus("Microphone enabled. Looking for host...");

        if (subscribedRef.current) {
          send({
            type: "join",
            name: nameRef.current,
          });
        }
      } catch (error) {
        setStatus("Microphone error: " + error.message);
      }
    } else {
      const newValue =
        !micStreamRef.current.getAudioTracks()[0]?.enabled;

      micStreamRef.current
        .getAudioTracks()
        .forEach((track) => {
          track.enabled = newValue;
        });

      setMicOn(newValue);
    }
  };

  return {
    status,
    connected,
    micOn,
    singers,
    toggleMic,
  };
}

// ==================================================
// INDIVIDUAL SINGER AUDIO
// ==================================================

function SingerAudio({ singer, resumeToken }) {
  const audioRef = useRef(null);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    if (!audioRef.current || !singer.stream) return;

    audioRef.current.srcObject = singer.stream;
    audioRef.current.volume = volume;

    audioRef.current.play().catch(() => {});
  }, [singer.stream, resumeToken]);

  const changeVolume = (event) => {
    const next = Number(event.target.value);
    setVolume(next);

    if (audioRef.current) {
      audioRef.current.volume = next;
    }
  };

  return (
    <div className="singerRow">
      <div>
        <strong>🎤 {singer.name}</strong>

        <p className="small">
          {singer.connected
            ? "🟢 Connected"
            : "🟡 Connecting..."}
        </p>
      </div>

      <label className="singerVolume">
        Volume: {Math.round(volume * 100)}%

        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={changeVolume}
        />
      </label>

      <audio
        ref={audioRef}
        autoPlay
        playsInline
        style={{ display: "none" }}
      />
    </div>
  );
}

// ==================================================
// HOST SCREEN - YOUTUBE KARAOKE + QR CODE
// ==================================================

function Host({ room }) {
  const { status, singers } = useKaraokeRoom("host", room);

  const [selectedSong, setSelectedSong] = useState(null);
  const [qrUrl, setQrUrl] = useState("");
  const [resumeToken, setResumeToken] = useState(0);

  const link =
    `${window.location.origin}${window.location.pathname}` +
    `?role=mic&room=${room}`;

  // Generate QR code for phones.
  useEffect(() => {
    let active = true;

    QRCode.toDataURL(link, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (active) setQrUrl(url);
      })
      .catch((error) => {
        console.error("QR generation failed:", error);
      });

    return () => {
      active = false;
    };
  }, [link]);

  const connectedCount = singers.filter(
    (singer) => singer.connected
  ).length;

  return (
    <main className="layout">
      {/* HEADER */}
      <header className="panel hero">
        <p className="eyebrow">YOUTUBE DUET KARAOKE</p>

        <h1>SingSpace 🎤</h1>

        <p>
          Choose a YouTube karaoke song and sing with
          your friends using your phones as microphones!
        </p>

        <span
          className={`status ${
            connectedCount > 0 ? "online" : ""
          }`}
        >
          {status} · {connectedCount} connected singer(s)
        </span>
      </header>

      {/* MAIN VIDEO PLAYER */}
      <section className="panel karaoke-player">
        <h2>🎵 Now Singing</h2>

        {selectedSong ? (
          <>
            <h3>{selectedSong.title}</h3>
            <p className="small">{selectedSong.artist}</p>

            <div className="youtube-container">
              <iframe
                key={selectedSong.id}
                src={
                  `https://www.youtube.com/embed/` +
                  selectedSong.youtubeId
                }
                title={`${selectedSong.title} Karaoke`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>

            <button
              className="secondary-button"
              onClick={() => setSelectedSong(null)}
            >
              Close Song
            </button>
          </>
        ) : (
          <div className="empty-player">
            <span className="empty-icon">🎤</span>
            <h3>No song selected</h3>
            <p>Choose a karaoke song from the library below.</p>
          </div>
        )}
      </section>

      {/* SONG SELECTION */}
      <section className="panel">
        <SongLibrary onSelectSong={setSelectedSong} />
      </section>

      {/* PHONES + MICROPHONE CONTROLS */}
      <div className="twoCol">
        <section className="panel">
          <h2>📱 Connect Your Phones</h2>

          <p className="small">
            Scan the same QR code with each phone.
          </p>

          <div className="qr">
            {qrUrl ? (
              <img
                src={qrUrl}
                alt="Scan to join karaoke room"
                width="188"
                height="188"
              />
            ) : (
              <span>Generating QR code...</span>
            )}
          </div>

          <p className="room">
            Room Code: <strong>{room}</strong>
          </p>

          <button
            onClick={() =>
              navigator.clipboard
                .writeText(link)
                .catch(console.error)
            }
          >
            Copy Phone Link
          </button>

          <p className="small">
            Each singer should open this link on their phone.
          </p>

          <a className="micLink" href={link}>
            {link}
          </a>
        </section>

        <section className="panel">
          <h2>🎙️ Connected Microphones</h2>

          <p className="small">
            Connected singers: {connectedCount}
          </p>

          {singers.length > 0 ? (
            singers.map((singer) => (
              <SingerAudio
                key={singer.id}
                singer={singer}
                resumeToken={resumeToken}
              />
            ))
          ) : (
            <p className="small">
              No phones connected yet. Scan the QR code
              to join the karaoke room.
            </p>
          )}

          <button
            onClick={() =>
              setResumeToken((number) => number + 1)
            }
          >
            🔊 Enable / Resume Voice Audio
          </button>

          <p className="small">
            Each singer has their own volume control.
            Keep speakers at a low volume to prevent feedback.
          </p>
        </section>
      </div>
    </main>
  );
}

// ==================================================
// PHONE MICROPHONE SCREEN
// ==================================================

function Mic({ room }) {
  const {
    status,
    connected,
    micOn,
    toggleMic,
  } = useKaraokeRoom("mic", room);

  const [name, setName] = useState("");

  return (
    <main className="phone">
      <section className="panel hero">
        <p className="eyebrow">WIRELESS MICROPHONE</p>

        <h1>🎤 Your Microphone</h1>

        <p>
          Room: <strong>{room}</strong>
        </p>

        <label>
          Your Singer Name

          <input
            maxLength="24"
            placeholder="Enter your name"
            value={name}
            onChange={(event) =>
              setName(event.target.value)
            }
          />
        </label>

        <span
          className={`status ${
            connected ? "online" : ""
          }`}
        >
          {status}
        </span>

        <button
          className="bigButton"
          onClick={() => toggleMic(name)}
        >
          {micOn
            ? "🔇 Mute Microphone"
            : "🎤 Enable Microphone"}
        </button>

        <p className="small">
          Keep your phone away from the speakers
          to prevent feedback.
        </p>
      </section>
    </main>
  );
}

// ==================================================
// HOMEPAGE + ROUTING
// ==================================================

export default function App() {
  const [room, setRoom] = useState(initial.get("room") || "");
  const [role, setRole] = useState(initial.get("role") || "");
  const [joinCode, setJoinCode] = useState("");

  const navigate = (nextRole, nextRoom) => {
    window.history.pushState(
      {},
      "",
      `?role=${nextRole}&room=${nextRoom}`
    );

    setRoom(nextRoom);
    setRole(nextRole);
  };

  if (!configured) {
    return (
      <main className="phone">
        <section className="panel">
          <h1>Setup Needed</h1>

          <p>
            Add your Supabase URL and publishable key
            to .env.local, then rebuild.
          </p>
        </section>
      </main>
    );
  }

  if (role === "host" && room) {
    return <Host room={room} />;
  }

  if (role === "mic" && room) {
    return <Mic room={room} />;
  }

  return (
    <main className="phone">
      <section className="panel hero">
        <h1>SingSpace 🎤</h1>

        <p>
          Sing your favourite karaoke songs using
          your phone as a wireless microphone.
        </p>

        <button
          className="bigButton"
          onClick={() => navigate("host", randomId())}
        >
          🎵 Start Karaoke
        </button>

        <div className="dividerText">or</div>

        <label>
          Join With Room Code

          <input
            value={joinCode}
            onChange={(event) =>
              setJoinCode(
                event.target.value
                  .toLowerCase()
                  .replace(/[^a-f0-9]/g, "")
                  .slice(0, 12)
              )
            }
            placeholder="12-character room code"
          />
        </label>

        <button
          disabled={joinCode.length !== 12}
          onClick={() => navigate("mic", joinCode)}
        >
          🎤 Use This Device as Microphone
        </button>
      </section>
    </main>
  );
}

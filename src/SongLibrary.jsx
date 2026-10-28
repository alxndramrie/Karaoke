
import { useState } from "react";

export default function SongLibrary({ onSelectSong }) {
  const [search, setSearch] = useState("");
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const searchYouTube = async (event) => {
    event.preventDefault();

    const query = search.trim();

    if (query.length < 3) {
      setError("Please enter at least 3 characters.");
      return;
    }

    setLoading(true);
    setError("");
    setHasSearched(true);
    setSongs([]);

    try {
      const response = await fetch(
        `/api/youtube/search?q=${encodeURIComponent(query)}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "YouTube search failed."
        );
      }

      setSongs(data.songs || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="song-library">
      <h2>🎵 Search Karaoke Songs</h2>

      <p className="small">
        Search YouTube for your favourite karaoke songs.
      </p>

      {/* SEARCH FORM */}
      <form
        className="youtube-search-form"
        onSubmit={searchYouTube}
      >
        <input
          type="search"
          className="song-search"
          placeholder="Search song or artist..."
          value={search}
          maxLength={80}
          onChange={(event) =>
            setSearch(event.target.value)
          }
        />

        <button
          type="submit"
          disabled={loading || search.trim().length < 3}
        >
          {loading ? "Searching..." : "🔍 Search YouTube"}
        </button>
      </form>

      {/* ERROR MESSAGE */}
      {error && (
        <p className="search-error" role="alert">
          {error}
        </p>
      )}

      {/* LOADING */}
      {loading && (
        <p className="small">
          Finding karaoke videos...
        </p>
      )}

      {/* SEARCH RESULTS */}
      {!loading && songs.length > 0 && (
        <>
          <h3 className="search-results-title">
            Search Results ({songs.length})
          </h3>

          <div className="song-grid">
            {songs.map((song) => (
              <article
                className="song-card"
                key={song.youtubeId}
              >
                <img
                  className="song-thumbnail"
                  src={
                    song.thumbnail ||
                    `https://img.youtube.com/vi/${song.youtubeId}/hqdefault.jpg`
                  }
                  alt=""
                  loading="lazy"
                />

                <div className="song-info">
                  <h3>{song.title}</h3>

                  <p>{song.artist}</p>

                  <button
                    onClick={() =>
                      onSelectSong(song)
                    }
                  >
                    ▶ Sing This Song
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {/* EMPTY RESULTS */}
      {!loading &&
        !error &&
        hasSearched &&
        songs.length === 0 && (
          <p className="small">
            No karaoke videos found. Try another song.
          </p>
        )}
    </div>
  );
}

# Stremio Simkl Scrobbler

A robust Stremio addon that scrobbles your watched Movies, Shows, and Anime to **Simkl** and **AniList**.

## Features

- 🔄 **Auto-Scrobbling:** Automatically marks items as watched on Simkl.
- 🦊 **AniList Integration:** Optional support to sync Anime progress to AniList.
- ⏱️ **Duration-Based:** Scrobbles only after you've watched 80% (configurable) of the content.
- 📂 **Catalogs:** Displays your "Watching" and "Plan to Watch" lists directly in Stremio.
- 🚀 **Smart Trigger:** Tracking starts only when playback begins (Subtitles request).

## Setup

### Prerequisites

- [Simkl Client ID & Secret](https://simkl.com/settings/developer/)
- [AniList Client ID & Secret](https://anilist.co/settings/developer) (Optional)
- [Redis](https://redis.io/) (Included in Docker setup)

### Environment Variables

Create a `.env` file (see `.env.example`):

```env
SIMKL_CLIENT_ID=your_id
SIMKL_CLIENT_SECRET=your_secret
ANILIST_CLIENT_ID=optional_id
ANILIST_CLIENT_SECRET=optional_secret
ENCRYPTION_KEY=24_byte_random_string
SCROBBLE_THRESHOLD=0.8
PORT=7001
REDIS_URL=redis://localhost:6379
```

## Running with Docker (Recommended)

The easiest way to run the addon is using Docker Compose, which includes a Redis instance.

```bash
docker-compose up -d --build
```

Access the addon interface at `http://localhost:7001`.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start Redis locally.
3. Run the addon:
   ```bash
   npm run dev
   ```

## Authorization

1. Open the addon configuration page (`/configure`).
2. Log in with Simkl.
3. (Optional) Enable and connect AniList.
4. Install the addon in Stremio.

## License

MIT

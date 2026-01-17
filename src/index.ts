import 'dotenv/config';
import { addonBuilder, serveHTTP, Args } from 'stremio-addon-sdk';
import manifest from './manifest';
import { encrypt, decrypt } from './crypto';
import { lookupByImdb, lookupByKitsu, exchangeCodeForToken, getAuthUrl, getUserList, simklItemToStremiometa } from './simkl';
import { getAniListAuthUrl, updateAnimeProgress, getAniListUser } from './anilist';
import { scheduleScrobble, initScrobbleWorker, shutdownQueue, ScrobbleJobData } from './queue';

const MINIMUM_RUNTIME_MINUTES = 5; // Ignore content shorter than 5 minutes

interface UserConfig {
  token?: string;           // Simkl token
  anilistToken?: string;    // AniList token
  threshold?: string;
  movies?: string;  // '1' or '0'
  shows?: string;   // '1' or '0'
  anime?: string;   // '1' or '0'
  anilistEnabled?: string;  // '1' or '0'
  catWatchingMovies?: string;
  catWatchingShows?: string;
  catWatchingAnime?: string;
  catPlanMovies?: string;
  catPlanShows?: string;
  catPlanAnime?: string;
  // AniList catalogs
  aniCatWatchingAnime?: string;
  aniCatPlanAnime?: string;
}

/**
 * Parse Stremio ID format.
 * Movies: "tt1234567"
 * Series: "tt1234567:1:5" (show:season:episode)
 * Anime: "kitsu:12345:1" (kitsu:id:episode)
 */
function parseStremioId(id: string): {
  imdbId?: string;
  kitsuId?: string;
  season?: number;
  episode?: number;
  isAnime: boolean;
} {
  // Check for Kitsu ID format
  if (id.startsWith('kitsu:')) {
    const parts = id.split(':');
    const kitsuId = parts[1];
    const episode = parts.length >= 3 ? parseInt(parts[2], 10) : undefined;
    return { kitsuId, episode, isAnime: true };
  }

  // IMDb format
  const parts = id.split(':');
  const imdbId = parts[0];

  if (parts.length === 3) {
    return {
      imdbId,
      season: parseInt(parts[1], 10),
      episode: parseInt(parts[2], 10),
      isAnime: false,
    };
  }

  return { imdbId, isAnime: false };
}

/**
 * Get the scrobble threshold from config or default.
 */
function getThreshold(config: UserConfig): number {
  const threshold = parseFloat(config.threshold || process.env.SCROBBLE_THRESHOLD || '0.8');
  return Math.max(0.1, Math.min(1.0, threshold)); // Clamp between 0.1 and 1.0
}

/**
 * Check if a content type is enabled in user config.
 */
function isTypeEnabled(config: UserConfig, contentType: 'movie' | 'series' | 'anime'): boolean {
  // Default to enabled if not specified
  if (contentType === 'movie') return config.movies !== '0';
  if (contentType === 'series') return config.shows !== '0';
  if (contentType === 'anime') return config.anime !== '0';
  return true;
}

// Build the addon
const builder = new addonBuilder(manifest);

// Stream handler - triggered when user starts watching content
// Stream handler - triggered when user starts watching content
// using subtitles request as a proxy for "playback started"
builder.defineSubtitlesHandler(async ({ type, id, extra, config }: Args & { config?: UserConfig }) => {
  console.log(`\n[Subtitles Request] Type: ${type}, ID: ${id}`);
  if (extra) {
    console.log('[Subtitles Request] Extra:', JSON.stringify(extra));
  }

  // Check for user token
  if (!config?.token) {
    console.log('No user token configured, skipping scrobble');
    return { subtitles: [] };
  }

  // Check if this content type is enabled
  const contentType = type === 'movie' ? 'movie' : (type === 'anime' ? 'anime' : 'series');
  if (!isTypeEnabled(config, contentType)) {
    console.log(`${contentType} scrobbling is disabled, skipping`);
    return { subtitles: [] };
  }

  // Decrypt the access token
  let accessToken: string;
  try {
    accessToken = decrypt(config.token);
  } catch (error) {
    console.error('Failed to decrypt token:', error);
    return { subtitles: [] };
  }

  // Parse the Stremio ID
  const { imdbId, kitsuId, season, episode, isAnime } = parseStremioId(id);

  let lookup;
  let displayId: string;

  if (isAnime && kitsuId) {
    // Anime with Kitsu ID
    displayId = `kitsu:${kitsuId}`;
    lookup = await lookupByKitsu(kitsuId, accessToken);
  } else if (imdbId && imdbId.startsWith('tt')) {
    // Movie/Series with IMDb ID
    displayId = imdbId;
    lookup = await lookupByImdb(imdbId, accessToken);
  } else {
    console.log(`Invalid ID format: ${id}`);
    return { subtitles: [] };
  }

  if (!lookup) {
    console.log(`Could not find ${displayId} in Simkl, skipping scrobble`);
    return { subtitles: [] };
  }

  const { simklId, runtime, type: mediaType } = lookup;

  // Check minimum runtime (avoid scrobbling trailers/clips)
  if (runtime < MINIMUM_RUNTIME_MINUTES) {
    console.log(`Runtime ${runtime}m is below minimum ${MINIMUM_RUNTIME_MINUTES}m, skipping`);
    return { subtitles: [] };
  }

  // Calculate delay based on threshold
  const threshold = getThreshold(config);
  const delayMs = Math.floor(runtime * 60 * 1000 * threshold);

  console.log(`Scheduling scrobble: ${displayId} (Simkl ID: ${simklId})`);
  console.log(`Runtime: ${runtime}m, Threshold: ${threshold * 100}%, Delay: ${Math.round(delayMs / 60000)}m`);

  // Determine job type
  let jobType: 'movie' | 'episode' | 'anime';
  if (isAnime || mediaType === 'anime') {
    jobType = 'anime';
  } else if (type === 'series' && season !== undefined && episode !== undefined) {
    jobType = 'episode';
  } else {
    jobType = 'movie';
  }

  // Create job data
  const jobData: ScrobbleJobData = {
    userId: config.token, // Use encrypted token as user ID
    type: jobType,
    simklId,
    token: accessToken,
    title: displayId,
    anilistToken: config.anilistToken,
    // Try to get MAL ID from Simkl lookup result if available
    malId: (lookup as any).ids?.mal,
    ...(jobType === 'episode' && { season, episode }),
    ...(jobType === 'anime' && { episode }),
  };

  // Schedule the scrobble (this also cancels any pending scrobble for this user)
  await scheduleScrobble(config.token, jobData, delayMs);

  // Return empty subtitles - this addon is a passthrough for scrobbling only
  return { subtitles: [] };
});

// Catalog handler - shows user's watching and plan-to-watch lists
builder.defineCatalogHandler(async ({ type, id, config }: Args & { config?: UserConfig }) => {
  console.log(`\n[Catalog Request] Type: ${type}, ID: ${id}`);

  // Check for user token
  if (!config?.token) {
    console.log('No user token configured');
    return { metas: [] };
  }

  // Decrypt the access token
  let accessToken: string;
  try {
    accessToken = decrypt(config.token);
  } catch (error) {
    console.error('Failed to decrypt token:', error);
    return { metas: [] };
  }

  // Map catalog ID to config key
  const catalogConfigMap: Record<string, keyof UserConfig> = {
    // Simkl
    'simkl-watching-movies': 'catWatchingMovies',
    'simkl-watching-shows': 'catWatchingShows',
    'simkl-watching-anime': 'catWatchingAnime',
    'simkl-plantowatch-movies': 'catPlanMovies',
    'simkl-plantowatch-shows': 'catPlanShows',
    'simkl-plantowatch-anime': 'catPlanAnime',
    // AniList
    'anilist-watching-anime': 'aniCatWatchingAnime',
    'anilist-plan-anime': 'aniCatPlanAnime',
  };

  const configKey = catalogConfigMap[id];
  if (configKey && config[configKey] === '0') {
    console.log(`Catalog ${id} is disabled`);
    return { metas: [] };
  }

  // Handle AniList Catalogs
  if (id.startsWith('anilist-')) {
    if (!config.anilistToken || config.anilistEnabled === '0') {
      console.log('AniList is disabled or token missing');
      return { metas: [] };
    }

    const aniStatus = id.includes('watching') ? 'CURRENT' : 'PLANNING';
    const decodedAnilistToken = Buffer.from(config.anilistToken, 'base64').toString();

    // Import here to avoid circular dependencies if any (or just at top)
    // Assuming getAniListUserList is imported at top
    const { getAniListUserList } = await import('./anilist');

    const metas = await getAniListUserList(aniStatus, decodedAnilistToken);
    console.log(`Fetched ${metas.length} items from AniList catalog ${id}`);
    return { metas };
  }

  // Handle Simkl Catalogs
  // Parse catalog ID to get list type and status
  // Format: simkl-{status}-{listType}
  const parts = id.split('-');
  if (parts.length < 3) return { metas: [] };

  const status = parts[1] as 'watching' | 'plantowatch';
  const listType = parts[2] as 'movies' | 'shows' | 'anime';

  // Fetch the list from Simkl
  const items = await getUserList(listType, status, accessToken);
  console.log(`Fetched ${items.length} ${status} ${listType} from Simkl`);

  // Convert to Stremio meta format
  const stremioType = type === 'movie' ? 'movie' : 'series';
  const metas = items
    .map(item => simklItemToStremiometa(item, stremioType))
    .filter(Boolean);

  return { metas };
});

// Get the addon interface
const addonInterface = builder.getInterface();

// Custom route handler for OAuth configuration
function handleConfigureRequest(req: any, res: any): void {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 7000}`;
  const redirectUri = `${baseUrl}/callback`;

  // Parse query params
  const url = new URL(req.url, baseUrl);
  const code = url.searchParams.get('code');

  if (code) {
    // Handle OAuth callback
    exchangeCodeForToken(code, redirectUri)
      .then((accessToken) => {
        const encryptedToken = encrypt(accessToken);
        const addonUrl = `${baseUrl}/${encodeURIComponent(JSON.stringify({ token: encryptedToken }))}/manifest.json`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Simkl Scrobbler - Connected!</title>
            <style>
              body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
              .success { color: #22c55e; }
              .url { background: #f1f5f9; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 14px; }
              button { background: #8B5CF6; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin-top: 10px; }
              button:hover { background: #7C3AED; }
            </style>
          </head>
          <body>
            <h1 class="success">✓ Connected to Simkl!</h1>
            <p>Your addon URL is:</p>
            <div class="url">${addonUrl}</div>
            <button onclick="navigator.clipboard.writeText('${addonUrl}')">Copy URL</button>
            <p style="margin-top: 20px;">Add this URL to Stremio to enable automatic scrobbling.</p>
            <p><a href="stremio://${addonUrl.replace(/^https?:\/\//, '')}">Click here to install in Stremio</a></p>
          </body>
          </html>
        `);
      })
      .catch((error) => {
        console.error('OAuth error:', error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Error</title></head>
          <body>
            <h1>Authentication Failed</h1>
            <p>${error.message}</p>
            <a href="/configure">Try again</a>
          </body>
          </html>
        `);
      });
  } else {
    // Show login page
    const authUrl = getAuthUrl(redirectUri);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Simkl Scrobbler - Connect</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          .logo { font-size: 48px; margin-bottom: 20px; }
          a.button { display: inline-block; background: #8B5CF6; color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-size: 18px; }
          a.button:hover { background: #7C3AED; }
          .info { margin-top: 30px; color: #64748b; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="logo">🎬</div>
        <h1>Simkl Scrobbler</h1>
        <p>Automatically track your movies and TV shows on Simkl.</p>
        <p style="margin: 30px 0;">
          <a href="${authUrl}" class="button">Connect with Simkl</a>
        </p>
        <div class="info">
          <p>This addon will scrobble content after you've watched 80% of it.</p>
          <p>Your credentials are encrypted and stored only in your addon URL.</p>
        </div>
      </body>
      </html>
    `);
  }
}

// Start the server
const PORT = parseInt(process.env.PORT || '7000', 10);

// Initialize the scrobble worker
initScrobbleWorker();

// Create Express app with addon routes
import express from 'express';

const app = express();

// Custom routes for OAuth
app.get('/configure', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const redirectUri = `${baseUrl}/callback`;

  res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Simkl Scrobbler - Configure</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; text-align: center; background: #0f172a; color: #e2e8f0; }
          .logo { font-size: 64px; margin-bottom: 20px; }
          h1 { color: #f1f5f9; margin-bottom: 10px; }
          p.subtitle { color: #94a3b8; font-size: 18px; margin-bottom: 40px; }
          
          .button { display: inline-block; background: #8B5CF6; color: white; text-decoration: none; padding: 16px 32px; border-radius: 8px; font-size: 18px; border: none; cursor: pointer; font-weight: 600; transition: background 0.2s; }
          .button:hover { background: #7C3AED; }
          .info { margin-top: 40px; color: #64748b; font-size: 14px; }
          
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; text-align: left; }
          .card { background: #1e293b; padding: 24px; border-radius: 12px; border: 1px solid #334155; }
          .card h2 { margin-top: 0; display: flex; align-items: center; gap: 10px; font-size: 20px; border-bottom: 1px solid #334155; padding-bottom: 15px; margin-bottom: 20px; }
          
          .section-title { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 20px 0 10px 0; font-weight: 600; }
          .first-section { margin-top: 0; }
          
          .option { display: flex; align-items: center; margin: 12px 0; }
          .option input[type="checkbox"] { width: 18px; height: 18px; margin-right: 12px; accent-color: #8B5CF6; cursor: pointer; }
          .option label { font-size: 15px; cursor: pointer; color: #e2e8f0; }
          .option-desc { color: #94a3b8; font-size: 13px; margin: -5px 0 15px 30px; line-height: 1.4; }
          
          .full-width { grid-column: 1 / -1; }
          
          .threshold-container { display: flex; align-items: center; gap: 15px; background: #0f172a; padding: 15px; border-radius: 8px; }
          
          @media (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div class="logo">🎬</div>
        <h1>Simkl Scrobbler</h1>
        <p class="subtitle">Sync your watch history across platforms</p>
        
        <form id="configForm" action="/auth" method="GET">
          <div class="grid">
            <!-- Simkl Column -->
            <div class="card">
              <h2 style="color: #4ade80;">✅ Simkl</h2>
              
              <div class="section-title first-section">Scrobbling</div>
              <div class="option">
                <input type="checkbox" id="movies" name="movies" value="1" checked>
                <label for="movies">🎥 Movies</label>
              </div>
              <div class="option">
                <input type="checkbox" id="shows" name="shows" value="1" checked>
                <label for="shows">📺 TV Shows</label>
              </div>
              <div class="option">
                <input type="checkbox" id="anime" name="anime" value="1" checked>
                <label for="anime">🌸 Anime</label>
              </div>
              
              <div class="section-title">Catalogs (Watching)</div>
              <div class="option">
                <input type="checkbox" id="catWatchingMovies" name="catWatchingMovies" value="1" checked>
                <label for="catWatchingMovies">🎥 Movies</label>
              </div>
              <div class="option">
                <input type="checkbox" id="catWatchingShows" name="catWatchingShows" value="1" checked>
                <label for="catWatchingShows">📺 Shows</label>
              </div>
              <div class="option">
                <input type="checkbox" id="catWatchingAnime" name="catWatchingAnime" value="1" checked>
                <label for="catWatchingAnime">🌸 Anime</label>
              </div>
              
              <div class="section-title">Catalogs (Plan to Watch)</div>
              <div class="option">
                <input type="checkbox" id="catPlanMovies" name="catPlanMovies" value="1" checked>
                <label for="catPlanMovies">🎥 Movies</label>
              </div>
              <div class="option">
                <input type="checkbox" id="catPlanShows" name="catPlanShows" value="1" checked>
                <label for="catPlanShows">📺 Shows</label>
              </div>
              <div class="option">
                <input type="checkbox" id="catPlanAnime" name="catPlanAnime" value="1" checked>
                <label for="catPlanAnime">🌸 Anime</label>
              </div>
            </div>
            
            <!-- AniList Column -->
            <div class="card">
              <h2 style="color: #0ea5e9;">🔗 AniList</h2>
              
              <div class="section-title first-section">Integration</div>
              <div class="option">
                <input type="checkbox" id="anilistEnabled" name="anilistEnabled" value="1" onchange="toggleAniListOptions()">
                <label for="anilistEnabled">Enable AniList Support</label>
              </div>
              <div class="option-desc">Connect your AniList account to sync anime progress.</div>
              
              <div id="anilistOptions" style="opacity: 0.5; pointer-events: none; transition: opacity 0.3s;">
                <div class="section-title">Catalogs (Watching)</div>
                <div class="option">
                  <input type="checkbox" id="aniCatWatchingAnime" name="aniCatWatchingAnime" value="1" checked>
                  <label for="aniCatWatchingAnime">🌸 Anime</label>
                </div>
                
                <div class="section-title">Catalogs (Plan to Watch)</div>
                <div class="option">
                  <input type="checkbox" id="aniCatPlanAnime" name="aniCatPlanAnime" value="1" checked>
                  <label for="aniCatPlanAnime">🌸 Anime</label>
                </div>
              </div>
            </div>
            
            <!-- General Settings (Full Width) -->
            <div class="card full-width">
              <h2>⚙️ General Settings</h2>
              
              <div class="section-title first-section">Scrobble Threshold</div>
              <div class="threshold-container">
                <input type="range" id="threshold" name="threshold" min="10" max="100" value="80" 
                       style="flex: 1; accent-color: #8B5CF6;"
                       oninput="document.getElementById('thresholdValue').textContent = this.value + '%'">
                <span id="thresholdValue" style="min-width: 45px; color: #f1f5f9; font-weight: bold; font-size: 18px;">80%</span>
              </div>
              <div class="option-desc" style="margin-top: 10px; margin-left: 0;">Mark as watched after watching this percentage of content</div>
            </div>
          </div>
          
          <div style="margin-top: 40px;">
            <button type="submit" class="button">Connect with Simkl →</button>
            <p style="margin-top: 15px; color: #64748b; font-size: 13px;">You'll be asked to connect AniList (optional) after Simkl.</p>
          </div>
        </form>
        
        <script>
          function toggleAniListOptions() {
            const enabled = document.getElementById('anilistEnabled').checked;
            const container = document.getElementById('anilistOptions');
            container.style.opacity = enabled ? '1' : '0.5';
            container.style.pointerEvents = enabled ? 'auto' : 'none';
          }
          // Init state
          toggleAniListOptions();
        </script>
      </body>
      </html>
    `);
});

app.get('/auth', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  // Store settings in state parameter
  const settings = {
    movies: req.query.movies === '1',
    shows: req.query.shows === '1',
    anime: req.query.anime === '1',
    anilistEnabled: req.query.anilistEnabled === '1',
    catWatchingMovies: req.query.catWatchingMovies === '1',
    catWatchingShows: req.query.catWatchingShows === '1',
    catWatchingAnime: req.query.catWatchingAnime === '1',
    catPlanMovies: req.query.catPlanMovies === '1',
    catPlanShows: req.query.catPlanShows === '1',
    catPlanAnime: req.query.catPlanAnime === '1',
    aniCatWatchingAnime: req.query.aniCatWatchingAnime === '1',
    aniCatPlanAnime: req.query.aniCatPlanAnime === '1',
    threshold: req.query.threshold || '80',
  };
  const state = Buffer.from(JSON.stringify(settings)).toString('base64');
  const redirectUri = `${baseUrl}/callback`;
  const authUrl = getAuthUrl(redirectUri) + `&state=${state}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const redirectUri = `${baseUrl}/callback`;
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code) {
    res.status(400).send('Missing authorization code');
    return;
  }

  // Decode settings from state
  let settings: any = {
    movies: true, shows: true, anime: true,
    anilistEnabled: false,
    catWatchingMovies: true, catWatchingShows: true, catWatchingAnime: true,
    catPlanMovies: true, catPlanShows: true, catPlanAnime: true,
    aniCatWatchingAnime: true, aniCatPlanAnime: true,
    threshold: '80'
  };
  if (state) {
    try {
      settings = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      console.warn('Failed to parse state, using defaults');
    }
  }

  try {
    const accessToken = await exchangeCodeForToken(code, redirectUri);
    const encryptedToken = encrypt(accessToken);

    // Include settings in addon config
    // Convert threshold from percentage (10-100) to decimal (0.1-1.0)
    const thresholdDecimal = (parseInt(settings.threshold || '80', 10) / 100).toFixed(2);

    const config: any = {
      token: encryptedToken,
      threshold: thresholdDecimal,
      movies: settings.movies ? '1' : '0',
      shows: settings.shows ? '1' : '0',
      anime: settings.anime ? '1' : '0',
      anilistEnabled: settings.anilistEnabled ? '1' : '0',
      catWatchingMovies: settings.catWatchingMovies ? '1' : '0',
      catWatchingShows: settings.catWatchingShows ? '1' : '0',
      catWatchingAnime: settings.catWatchingAnime ? '1' : '0',
      catPlanMovies: settings.catPlanMovies ? '1' : '0',
      catPlanShows: settings.catPlanShows ? '1' : '0',
      catPlanAnime: settings.catPlanAnime ? '1' : '0',
      aniCatWatchingAnime: settings.aniCatWatchingAnime ? '1' : '0',
      aniCatPlanAnime: settings.aniCatPlanAnime ? '1' : '0',
    };
    const addonUrl = `${baseUrl}/${encodeURIComponent(JSON.stringify(config))}/manifest.json`;

    // Show which content types are enabled
    const enabledScrobble = [];
    if (settings.movies) enabledScrobble.push('🎥 Movies');
    if (settings.shows) enabledScrobble.push('📺 Shows');
    if (settings.anime) enabledScrobble.push('🌸 Anime');

    const enabledCatalogs = [];
    if (settings.catWatchingMovies) enabledCatalogs.push('👀 Movies');
    if (settings.catWatchingShows) enabledCatalogs.push('👀 Shows');
    if (settings.catWatchingAnime) enabledCatalogs.push('👀 Anime');
    if (settings.catPlanMovies) enabledCatalogs.push('📋 Movies');
    if (settings.catPlanShows) enabledCatalogs.push('📋 Shows');
    if (settings.catPlanAnime) enabledCatalogs.push('📋 Anime');

    const enabledAniListCatalogs = [];
    if (settings.aniCatWatchingAnime) enabledAniListCatalogs.push('👀 Anime');
    if (settings.aniCatPlanAnime) enabledAniListCatalogs.push('📋 Anime');

    const anilistSection = settings.anilistEnabled ? `
            <div class="enabled" style="border: 1px solid #0ea5e9;">
              <div class="section-label" style="color: #38bdf8;">🔗 AniList:</div>
              <span class="enabled-item">⏳ Not connected yet</span>
              ${enabledAniListCatalogs.length > 0 ? `<div style="margin-top: 8px; font-size: 11px; color: #94a3b8;">Catalogs: ${enabledAniListCatalogs.join(', ')}</div>` : ''}
              <p style="margin: 10px 0 0 0;">
                <a href="/anilist-auth?config=${encodeURIComponent(JSON.stringify(config))}" 
                   style="background: #0ea5e9; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">
                  Connect AniList →
                </a>
              </p>
            </div>
    ` : '';

    res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Simkl Scrobbler - Connected!</title>
            <style>
              body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #0f172a; color: #e2e8f0; }
              .success { color: #22c55e; }
              .url { background: #1e293b; padding: 15px; border-radius: 8px; word-break: break-all; font-size: 13px; color: #94a3b8; margin: 15px 0; }
              button { background: #8B5CF6; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; margin: 5px; font-size: 14px; }
              button:hover { background: #7C3AED; }
              a { color: #8B5CF6; }
              .enabled { background: #1e293b; padding: 15px; border-radius: 8px; margin: 15px 0; }
              .enabled-item { display: inline-block; margin: 3px 5px; padding: 5px 12px; background: #334155; border-radius: 20px; font-size: 13px; }
              .section-label { color: #94a3b8; font-size: 12px; margin-bottom: 8px; }
            </style>
          </head>
          <body>
            <h1 class="success">✓ Connected to Simkl!</h1>
            
            <div class="enabled">
              <div class="section-label">📝 Scrobbling:</div>
              ${enabledScrobble.length > 0 ? enabledScrobble.map(t => '<span class="enabled-item">' + t + '</span>').join('') : '<span class="enabled-item" style="opacity:0.5">None</span>'}
            </div>
            
            <div class="enabled">
              <div class="section-label">📚 Catalogs:</div>
              ${enabledCatalogs.length > 0 ? enabledCatalogs.map(t => '<span class="enabled-item">' + t + '</span>').join('') : '<span class="enabled-item" style="opacity:0.5">None</span>'}
            </div>
            
            ${anilistSection}
            
            <p>${settings.anilistEnabled ? 'Install now (Simkl only) or connect AniList first:' : 'Your addon URL:'}</p>
            <div class="url">${addonUrl}</div>
            <button onclick="navigator.clipboard.writeText('${addonUrl}')">📋 Copy URL</button>
            <button onclick="location.href='stremio://${addonUrl.replace(/^https?:\/\//, '')}'">🚀 Install in Stremio</button>
            
            <p style="margin-top: 30px; color: #64748b; font-size: 13px;">
              <a href="/configure">← Reconfigure settings</a>
            </p>
          </body>
          </html>
        `);
  } catch (error: any) {
    console.error('OAuth error:', error);
    res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Error</title></head>
          <body>
            <h1>Authentication Failed</h1>
            <p>${error.message}</p>
            <a href="/configure">Try again</a>
          </body>
          </html>
        `);
  }
});

// Mount the addon routes using getRouter
import { getRouter } from 'stremio-addon-sdk';

// AniList OAuth routes (uses implicit grant - token in URL fragment)
// AniList OAuth routes (uses Authorization Code Grant)
app.get('/anilist-auth', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const redirectUri = `${baseUrl}/anilist-callback`;
  const configParam = req.query.config as string || '';
  // Pass config in the 'state' parameter (it's already URL encoded JSON, but let's be safe)
  // AniList 'state' parameter is preserved in the redirect
  const authUrl = getAniListAuthUrl(redirectUri) + `&state=${configParam}`;

  res.redirect(authUrl);
});

// AniList callback - handles Authorization Code Grant
app.get('/anilist-callback', async (req, res) => {
  const code = req.query.code as string;
  const configParam = req.query.state as string; // We'll pass config in 'state' now

  if (!code) {
    res.send('Error: check console for details');
    return;
  }

  try {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/anilist-callback`;

    // Import here to avoid circular dependencies
    const { exchangeAniListCodeForToken } = await import('./anilist');

    const accessToken = await exchangeAniListCodeForToken(code, redirectUri);
    const encodedToken = Buffer.from(accessToken).toString('base64');

    // Parse pending config
    let config: any = {};
    if (configParam) {
      try {
        config = JSON.parse(decodeURIComponent(configParam));
      } catch (e) {
        console.error('Failed to parse config:', e);
      }
    }

    // Add AniList token
    config.anilistToken = encodedToken;

    const addonUrl = `${baseUrl}/${encodeURIComponent(JSON.stringify(config))}/manifest.json`;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>AniList Connected!</title>
        <style>
          body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background: #0f172a; color: #e2e8f0; text-align: center; }
          .success { color: #0ea5e9; font-size: 24px; margin-bottom: 20px; }
          .url { background: #1e293b; padding: 15px; border-radius: 8px; word-break: break-all; font-size: 13px; color: #94a3b8; margin: 20px 0; }
          button { background: #0ea5e9; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; margin: 5px; font-size: 14px; font-weight: bold; }
          button:hover { background: #0284c7; }
        </style>
      </head>
      <body>
        <div class="success">✓ Connected to AniList!</div>
        <p>Your setup is complete.</p>
        
        <p>Your final addon URL:</p>
        <div class="url">${addonUrl}</div>
        
        <button onclick="navigator.clipboard.writeText('${addonUrl}')">📋 Copy URL</button>
        <button onclick="location.href='stremio://${addonUrl.replace(/^https?:\/\//, '')}'">🚀 Install in Stremio</button>
      </body>
      </html>
    `);

  } catch (error: any) {
    console.error('AniList auth error:', error);
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

app.use('/', getRouter(addonInterface));

app.listen(PORT, () => {
  console.log(`\n🎬 Simkl Scrobbler Addon running at http://localhost:${PORT}`);
  console.log(`📋 Configure at http://localhost:${PORT}/configure`);
  console.log(`📡 Manifest at http://localhost:${PORT}/manifest.json\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await shutdownQueue();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  await shutdownQueue();
  process.exit(0);
});

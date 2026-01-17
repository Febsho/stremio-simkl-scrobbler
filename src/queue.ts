import { Queue, Worker, Job } from 'bullmq';
import { scrobbleMovie, scrobbleEpisode, scrobbleAnime } from './simkl';
import { updateAnimeProgress, searchAnimeByMalId } from './anilist';

export interface ScrobbleJobData {
    userId: string;           // Encrypted token used as user identifier
    type: 'movie' | 'episode' | 'anime';
    simklId: number;
    season?: number;
    episode?: number;
    token: string;            // Decrypted Simkl access token
    anilistToken?: string;    // AniList access token (if connected)
    anilistId?: number;       // AniList media ID (if known)
    malId?: number;           // MyAnimeList ID (for AniList lookup)
    title?: string;           // For logging
}

const QUEUE_NAME = 'simkl-scrobble';

// Redis connection config for BullMQ (uses internal ioredis)
const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: null,
};

// Scrobble queue
const scrobbleQueue = new Queue(QUEUE_NAME, {
    connection: redisConfig as any,
    defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
    },
});

// Track pending jobs by user ID for cancellation
const userJobIds = new Map<string, string>();

/**
 * Schedule a scrobble job to run after a delay.
 * If a job already exists for this user, it will be cancelled first.
 */
export async function scheduleScrobble(
    userId: string,
    jobData: ScrobbleJobData,
    delayMs: number
): Promise<void> {
    // Cancel any existing pending job for this user
    await cancelPendingScrobble(userId);

    // Create unique job ID
    const jobId = `scrobble-${userId}-${Date.now()}`;

    // Add the delayed job
    await scrobbleQueue.add('scrobble', jobData, {
        delay: delayMs,
        jobId,
    });

    // Track the job ID for this user
    userJobIds.set(userId, jobId);

    console.log(`Scheduled scrobble for "${jobData.title}" in ${Math.round(delayMs / 60000)} minutes (job: ${jobId})`);
}

/**
 * Cancel any pending scrobble job for a user.
 * Returns true if a job was cancelled, false otherwise.
 */
export async function cancelPendingScrobble(userId: string): Promise<boolean> {
    const existingJobId = userJobIds.get(userId);

    if (existingJobId) {
        const job = await scrobbleQueue.getJob(existingJobId);

        if (job) {
            const state = await job.getState();

            if (state === 'delayed' || state === 'waiting') {
                await job.remove();
                console.log(`Cancelled pending scrobble job: ${existingJobId}`);
                userJobIds.delete(userId);
                return true;
            }
        }
    }

    userJobIds.delete(userId);
    return false;
}

/**
 * Process scrobble jobs when their delay expires.
 * Scrobbles to both Simkl and AniList (if enabled).
 */
async function processScrobbleJob(job: Job<ScrobbleJobData>): Promise<void> {
    const { type, simklId, season, episode, token, anilistToken, anilistId, malId, title } = job.data;

    console.log(`Processing scrobble job for "${title || simklId}"...`);

    let simklSuccess: boolean = false;
    let anilistSuccess: boolean = true; // Default to true if not using AniList

    // Scrobble to Simkl
    if (type === 'movie') {
        simklSuccess = await scrobbleMovie(simklId, token);
    } else if (type === 'episode' && season !== undefined && episode !== undefined) {
        simklSuccess = await scrobbleEpisode(simklId, season, episode, token);
    } else if (type === 'anime' && episode !== undefined) {
        simklSuccess = await scrobbleAnime(simklId, episode, token);

        // Also scrobble to AniList if token is provided
        if (anilistToken) {
            console.log('Also scrobbling to AniList...');

            // Decode base64 token
            const decodedAnilistToken = Buffer.from(anilistToken, 'base64').toString();

            let actualAnilistId = anilistId;

            // If we don't have AniList ID but have MAL ID, look it up
            if (!actualAnilistId && malId) {
                const result = await searchAnimeByMalId(malId, decodedAnilistToken);
                if (result) {
                    actualAnilistId = result.anilistId;
                    console.log(`Found AniList ID ${actualAnilistId} for MAL ID ${malId}`);
                }
            }

            if (actualAnilistId) {
                anilistSuccess = await updateAnimeProgress(actualAnilistId, episode, decodedAnilistToken);
            } else {
                console.warn('Could not find AniList ID for anime, skipping AniList scrobble');
                anilistSuccess = true; // Don't fail the job
            }
        }
    } else {
        console.error('Invalid job data: missing required fields for type ' + type);
        return;
    }

    if (!simklSuccess) {
        throw new Error(`Simkl scrobble failed for ${type} ${simklId}`);
    }

    if (!anilistSuccess) {
        console.warn('AniList scrobble failed, but Simkl succeeded');
    }
}

// Start the worker
let worker: Worker<ScrobbleJobData> | null = null;

/**
 * Initialize the scrobble worker.
 * Must be called once when the addon starts.
 */
export function initScrobbleWorker(): void {
    if (worker) {
        console.warn('Scrobble worker already initialized');
        return;
    }

    worker = new Worker<ScrobbleJobData>(
        QUEUE_NAME,
        processScrobbleJob,
        {
            connection: redisConfig as any,
            concurrency: 5,
        }
    );

    worker.on('completed', (job) => {
        console.log(`Scrobble job completed: ${job.id}`);
        if (job.data.userId) {
            userJobIds.delete(job.data.userId);
        }
    });

    worker.on('failed', (job, err) => {
        console.error(`Scrobble job failed: ${job?.id}`, err.message);
        if (job?.data.userId) {
            userJobIds.delete(job.data.userId);
        }
    });

    console.log('Scrobble worker initialized');
}

/**
 * Gracefully shutdown the queue and worker.
 */
export async function shutdownQueue(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
    await scrobbleQueue.close();
    console.log('Queue shutdown complete');
}

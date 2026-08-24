// accounting-redis.js
// Iekšējā grāmatvedība ar Upstash Redis – lietotāju kredītu un iemaksu uzskaite.
// Internal accounting with Upstash Redis – user credits and deposits tracking.

import { Redis } from '@upstash/redis';

let redis = null;

/**
 * Inicializē Redis, ja vides mainīgie ir pieejami.
 * Initializes Redis if environment variables are available.
 */
export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        console.log('✅ Redis inicializēts | Redis initialized');
    } else {
        console.log('⚠️ Redis nav konfigurēts | Redis is not configured');
    }
    return redis;
}

/**
 * Iegūst lietotāja kredītu bilanci.
 * Gets user credits balance.
 * @param {string} walletAddress - Lietotāja maka adrese | User wallet address.
 * @returns {Promise<bigint>} - Kredītu bilance | Credits balance.
 */
export async function getUserCredits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const credits = await redis.get(`user:${walletAddress.toLowerCase()}:winc`);
        return BigInt(String(credits || '0'));
    } catch (e) {
        console.warn('Redis get kļūda | Redis get error:', e.message);
        return 0n;
    }
}

/**
 * Atjaunina lietotāja kredītu bilanci.
 * Updates user credits balance.
 * @param {string} walletAddress - Lietotāja maka adrese | User wallet address.
 * @param {bigint} wincAmount - Kredītu summa winc | Credits amount in winc.
 */
export async function setUserCredits(walletAddress, wincAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:winc`, wincAmount.toString());
        console.log('✅ Lietotāja kredīti atjaunināti | User credits updated:', wincAmount.toString());
    } catch (e) {
        console.warn('Redis set kļūda | Redis set error:', e.message);
    }
}

/**
 * Iegūst lietotāja iemaksu bilanci.
 * Gets user deposits balance.
 * @param {string} walletAddress - Lietotāja maka adrese | User wallet address.
 * @returns {Promise<bigint>} - Iemaksu bilance | Deposits balance.
 */
export async function getUserDeposits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const deposits = await redis.get(`user:${walletAddress.toLowerCase()}:deposits`);
        return BigInt(String(deposits || '0'));
    } catch (e) {
        console.warn('Redis get kļūda | Redis get error:', e.message);
        return 0n;
    }
}

/**
 * Atjaunina lietotāja iemaksu bilanci.
 * Updates user deposits balance.
 * @param {string} walletAddress - Lietotāja maka adrese | User wallet address.
 * @param {bigint} depositAmount - Iemaksas summa wei | Deposit amount in wei.
 */
export async function setUserDeposits(walletAddress, depositAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:deposits`, depositAmount.toString());
        console.log('✅ Lietotāja iemaksas atjauninātas | User deposits updated:', depositAmount.toString());
    } catch (e) {
        console.warn('Redis set kļūda | Redis set error:', e.message);
    }
}

/**
 * Atgriež Redis klientu.
 * Returns the Redis client.
 * @returns {Redis|null} - Redis klients vai null | Redis client or null.
 */
export function getRedis() {
    return redis;
}

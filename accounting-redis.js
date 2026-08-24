// accounting-redis.js
// Iekšējā grāmatvedība ar Upstash Redis – lietotāju kredītu un iemaksu uzskaite.

import { Redis } from '@upstash/redis';

let redis = null;

// Inicializē Redis, ja vides mainīgie ir pieejami
export function initRedis() {
    if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        console.log('✅ Redis inicializēts');
    } else {
        console.log('⚠️ Redis nav konfigurēts');
    }
    return redis;
}

// Iegūst lietotāja kredītu bilanci
export async function getUserCredits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const credits = await redis.get(`user:${walletAddress.toLowerCase()}:winc`);
        return BigInt(String(credits || '0'));
    } catch (e) {
        console.warn('Redis get kļūda:', e.message);
        return 0n;
    }
}

// Atjaunina lietotāja kredītu bilanci
export async function setUserCredits(walletAddress, wincAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:winc`, wincAmount.toString());
        console.log('✅ Lietotāja kredīti atjaunināti:', wincAmount.toString());
    } catch (e) {
        console.warn('Redis set kļūda:', e.message);
    }
}

// Iegūst lietotāja iemaksu bilanci
export async function getUserDeposits(walletAddress) {
    if (!redis) return 0n;
    
    try {
        const deposits = await redis.get(`user:${walletAddress.toLowerCase()}:deposits`);
        return BigInt(String(deposits || '0'));
    } catch (e) {
        console.warn('Redis get kļūda:', e.message);
        return 0n;
    }
}

// Atjaunina lietotāja iemaksu bilanci
export async function setUserDeposits(walletAddress, depositAmount) {
    if (!redis) return;
    
    try {
        await redis.set(`user:${walletAddress.toLowerCase()}:deposits`, depositAmount.toString());
        console.log('✅ Lietotāja iemaksas atjauninātas:', depositAmount.toString());
    } catch (e) {
        console.warn('Redis set kļūda:', e.message);
    }
}

// Atgriež Redis klientu
export function getRedis() {
    return redis;
}

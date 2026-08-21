// healthChecks.js
// Visas servisu pārbaudes ar SSL ignorēšanu (testnet videi)
// All service checks with SSL bypass (for testnet environment)

import { request } from 'https';
import { ethers } from 'ethers';

// ============================================================
// KONSTANTES | CONSTANTS
// ============================================================

const ARWEAVE_GATEWAY_URL = 'https://ar-io.dev';
const BASE_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const TURBO_PAYMENT_URL = 'https://payment.services.ar-io.dev';
const TURBO_UPLOAD_URL = 'https://upload.services.ar-io.dev';

// ============================================================
// SSL IGNORĒŠANAS FUNKCIJA | SSL BYPASS FUNCTION
// ============================================================

/**
 * Veic HTTP pieprasījumu, ignorējot SSL sertifikāta kļūdas.
 * Performs an HTTP request, ignoring SSL certificate errors.
 * 
 * @param {string} url - URL adrese.
 * @returns {Promise<Object>} - Atbilde ar statusCode.
 */
function fetchWithNoSSL(url) {
    return new Promise((resolve, reject) => {
        const req = request(url, { rejectUnauthorized: false }, (res) => {
            resolve(res);
        });
        req.on('error', (err) => reject(err));
        req.end();
    });
}

// ============================================================
// ĀRĒJO SERVISU PĀRBAUDES | EXTERNAL SERVICE CHECKS
// ============================================================

/**
 * Arweave vārtejas pārbaude (ar-io.dev).
 * Checks Arweave gateway (ar-io.dev).
 */
export async function checkArweaveGateway() {
    try {
        const response = await fetchWithNoSSL(`${ARWEAVE_GATEWAY_URL}/ar-io/healthcheck`);
        return response.statusCode === 200;
    } catch {
        return false;
    }
}

/**
 * Base RPC pārbaude (base-sepolia-rpc.publicnode.com).
 * Checks Base RPC (base-sepolia-rpc.publicnode.com).
 */
export async function checkBaseRPC() {
    try {
        const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
        const block = await provider.getBlock('latest');
        return !!block;
    } catch {
        return false;
    }
}

/**
 * Turbo Payment API pārbaude (payment.services.ar-io.dev).
 * Checks Turbo Payment API (payment.services.ar-io.dev).
 */
export async function checkTurboPayment() {
    try {
        const response = await fetchWithNoSSL(`${TURBO_PAYMENT_URL}/v1/info`);
        return response.statusCode === 200;
    } catch {
        return false;
    }
}

/**
 * Turbo Upload API pārbaude (upload.services.ar-io.dev).
 * Checks Turbo Upload API (upload.services.ar-io.dev).
 */
export async function checkTurboUpload() {
    try {
        const response = await fetchWithNoSSL(`${TURBO_UPLOAD_URL}/v1/info`);
        return response.statusCode === 200;
    } catch {
        return false;
    }
}

// ============================================================
// SERVERA IEKŠĒJĀ PĀRBAUDE | SERVER INTERNAL CHECK
// ============================================================

/**
 * Servera iekšējā pārbaude – pārbauda Redis, vides mainīgos, operatora maku un Turbo SDK.
 * Server internal check – checks Redis, environment variables, operator wallet, and Turbo SDK.
 * 
 * @param {Object} params - { redis, rpcUrl, operatorPrivateKey, treasuryAddress, nftAddress }
 * @returns {Object} - { redis, envVars, operatorWallet, turboSDK }
 */
export async function checkServerInternals(params) {
    const {
        redis,
        rpcUrl,
        operatorPrivateKey,
        treasuryAddress,
        nftAddress
    } = params;

    const results = {
        redis: false,
        envVars: false,
        operatorWallet: false,
        turboSDK: false
    };

    // 1. Redis funkcionalitāte
    try {
        if (redis) {
            await redis.set('test:health', 'ok');
            const value = await redis.get('test:health');
            results.redis = value === 'ok';
            await redis.del('test:health');
        }
    } catch {
        // Redis nav pieejams
    }

    // 2. Vides mainīgie
    results.envVars = !!(rpcUrl && operatorPrivateKey && treasuryAddress && nftAddress);

    // 3. Operatora maks
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(operatorPrivateKey, provider);
        results.operatorWallet = !!wallet.address;
    } catch {
        // Operatora maks nevar inicializēties
    }

    // 4. Turbo SDK
    try {
        const signer = new EthereumSigner(operatorPrivateKey);
        const turbo = TurboFactory.authenticated({
            signer,
            token: 'base-eth',
            gatewayUrl: 'https://sepolia.base.org',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        results.turboSDK = !!turbo;
    } catch {
        // Turbo SDK nevar inicializēties
    }

    return results;
}

// ============================================================
// KOMBINĒTĀ PĀRBAUDE | COMBINED CHECK
// ============================================================

/**
 * Veic visas ārējās un iekšējās pārbaudes.
 * Performs all external and internal checks.
 * 
 * @param {Object} serverParams - { redis, rpcUrl, operatorPrivateKey, treasuryAddress, nftAddress }
 * @returns {Object} - { arweave, baseRPC, turboPayment, turboUpload, server, allHealthy }
 */
export async function checkAllServices(serverParams) {
    const results = {
        arweave: false,
        baseRPC: false,
        turboPayment: false,
        turboUpload: false,
        server: false,
        allHealthy: false
    };

    // Ārējās pārbaudes
    results.arweave = await checkArweaveGateway();
    results.baseRPC = await checkBaseRPC();
    results.turboPayment = await checkTurboPayment();
    results.turboUpload = await checkTurboUpload();

    // Servera iekšējā pārbaude
    const serverInternal = await checkServerInternals(serverParams);
    results.server = serverInternal.redis && serverInternal.envVars && 
                     serverInternal.operatorWallet && serverInternal.turboSDK;

    results.allHealthy = results.arweave && results.baseRPC && 
                         results.turboPayment && results.turboUpload && 
                         results.server;

    return results;
}

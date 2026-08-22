// healthChecks.js
// Visas ārējo servisu, blokķēdes un servera funkcionālās pārbaudes.
// All external service, blockchain, and server functional checks.

import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

// ============================================================
// KONSTANTES | CONSTANTS
// ============================================================

const KNOWN_ARWEAVE_TX = 'bVLEkL1SOPFCzIYi8T_QNnh17VIDp4RylU6YTwCMVRw';
const ARWEAVE_GATEWAY_URL = 'https://ar-io.dev';
const BASE_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
const TURBO_PAYMENT_URL = 'https://payment.services.ar-io.dev';
const TURBO_UPLOAD_URL = 'https://upload.services.ar-io.dev';

// ============================================================
// ĀRĒJO SERVISU PĀRBAUDES | EXTERNAL SERVICE CHECKS
// ============================================================

/**
 * Arweave vārtejas funkcionālā pārbaude (False Positive droša).
 * Mēģina iegūt zināmu transakciju, izmantojot HEAD pieprasījumu.
 */
export async function checkArweaveGateway() {
    try {
        const response = await fetch(`${ARWEAVE_GATEWAY_URL}/raw/${KNOWN_ARWEAVE_TX}`, {
            method: 'HEAD',
            timeout: 5000
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Base RPC funkcionālā pārbaude (False Positive droša).
 * Simulē nulles vērtības transakciju, izmantojot estimateGas.
 */
export async function checkBaseRPC() {
    try {
        const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
        const zeroWallet = new ethers.Wallet(ethers.ZeroAddress, provider);
        await provider.estimateGas({
            to: zeroWallet.address,
            value: 0n
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Turbo Payment API veselības pārbaude.
 * Pārbauda, vai /v1/info atbild un satur derīgas adreses.
 */
export async function checkTurboPayment() {
    try {
        const response = await fetch(`${TURBO_PAYMENT_URL}/v1/info`);
        if (!response.ok) return false;
        const data = await response.json();
        return !!data.addresses && Object.keys(data.addresses).length > 0;
    } catch {
        return false;
    }
}

/**
 * Turbo Upload API veselības pārbaude.
 * Pārbauda, vai /v1/info atgriež 200 OK.
 */
export async function checkTurboUpload() {
    try {
        const response = await fetch(`${TURBO_UPLOAD_URL}/v1/info`);
        return response.ok;
    } catch {
        return false;
    }
}

// ============================================================
// SERVERA IEKŠĒJĀ PĀRBAUDE | SERVER INTERNAL CHECK
// ============================================================

/**
 * Servera iekšējā funkcionālā pārbaude.
 * Pārbauda Redis, vides mainīgos, operatora maku un Turbo SDK.
 * 
 * @param {Object} params - { redis, rpcUrl, operatorPrivateKey, treasuryAddress, nftAddress }
 */
export async function checkServerInternals(params) {
    const {
        redis,
        rpcUrl,
        operatorPrivateKey,
        treasuryAddress,
        nftAddress,
        subscriptionAddress,
        registryAddress
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
        // Redis nav pieejams vai nedarbojas
    }

    // 2. Vides mainīgie
    results.envVars = !!(rpcUrl && operatorPrivateKey && treasuryAddress && nftAddress && subscriptionAddress && registryAddress);

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
 * @param {Object} serverParams - { redis, rpcUrl, operatorPrivateKey, treasuryAddress, nftAddress, subscriptionAddress, registryAddress }
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

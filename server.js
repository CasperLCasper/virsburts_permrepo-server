import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import {
    TurboFactory,
    EthereumSigner
} from '@ardrive/turbo-sdk';

// ============================================================
// PATHS
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// EXPRESS
// ============================================================

const app = express();

const PORT =
    Number(process.env.PORT) || 3000;

// ============================================================
// ENVIRONMENT
// ============================================================

const RPC_URL =
    process.env.RPC_URL;

const OPERATOR_PRIVATE_KEY =
    process.env.OPERATOR_PRIVATE_KEY;

const TREASURY_ADDRESS =
    process.env.TREASURY_ADDRESS;

const NFT_ADDRESS =
    process.env.NFT_ADDRESS;

const SUBSCRIPTION_ADDRESS =
    process.env.SUBSCRIPTION_ADDRESS;

const REGISTRY_ADDRESS =
    process.env.REGISTRY_ADDRESS;

const ARWEAVE_GATEWAY =
    process.env.ARWEAVE_GATEWAY ||
    'https://ar-io.dev';

const CHAIN_ID =
    process.env.CHAIN_ID ||
    '0x14a34';

const GITHUB_CLIENT_ID =
    process.env.GITHUB_CLIENT_ID;

const GITHUB_CLIENT_SECRET =
    process.env.GITHUB_CLIENT_SECRET;

const GITHUB_REDIRECT_URI =
    process.env.GITHUB_REDIRECT_URI;

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString('hex');

// ============================================================
// TURBO CONFIGURATION
// ============================================================
//
// base-eth = ETH on Base / Base Sepolia,
// depending on the configured Turbo environment.
//
// These URLs may be overridden through environment variables.
// ============================================================

const TURBO_TOKEN =
    process.env.TURBO_TOKEN ||
    'base-eth';

const TURBO_GATEWAY_URL =
    process.env.TURBO_GATEWAY_URL ||
    'https://arweave.net';

const TURBO_UPLOAD_URL =
    process.env.TURBO_UPLOAD_URL ||
    'https://upload.services.ar-io.dev';

const TURBO_PAYMENT_URL =
    process.env.TURBO_PAYMENT_URL ||
    'https://payment.services.ar-io.dev';

// ============================================================
// CONSTANTS
// ============================================================

const MAX_FILE_SIZE =
    100 * 1024 * 1024;

const GITHUB_PER_PAGE =
    100;

const TURBO_PAYMENT_WAIT_MS =
    Number(
        process.env.TURBO_PAYMENT_WAIT_MS || 5000
    );

// ============================================================
// ABIs
// ============================================================

const NFT_ABI = [
    'function repositoryTokens(bytes32 repoHash) external view returns (uint256)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function getBackupCount(uint256 tokenId) external view returns (uint256)',
    'function getManifestURI(uint256 tokenId) external view returns (string)',
    'function getNonce(uint256 tokenId) external view returns (uint256)'
];

const SUBSCRIPTION_ABI = [
    'function isSubscribed(uint256 tokenId) external view returns (bool)'
];

const REGISTRY_ABI = [
    'function getRepositoryByNFT(uint256 nftTokenId) external view returns (bytes32)'
];

const TREASURY_ABI = [
    'function payTurbo(uint256 amount, bytes32 paymentId) external',
    'function balance() external view returns (uint256)'
];

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    express.json({
        limit: '100mb'
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: '100mb'
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            'public'
        )
    )
);

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure:
                process.env.NODE_ENV === 'production',
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 60 * 60 * 1000
        }
    })
);

// ============================================================
// GENERAL HELPERS
// ============================================================

function errorMessage(error) {
    if (
        error &&
        typeof error.message === 'string'
    ) {
        return error.message;
    }

    return String(error);
}

function sleep(milliseconds) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                milliseconds
            )
    );
}

function isValidAddress(address) {
    return (
        typeof address === 'string' &&
        ethers.isAddress(address)
    );
}

function normalizeAddress(address) {
    if (!isValidAddress(address)) {
        throw new Error(
            'Nederīga Ethereum wallet adrese'
        );
    }

    return ethers.getAddress(address);
}

function isNonZeroBytes32(value) {
    return (
        typeof value === 'string' &&
        value !== ethers.ZeroHash
    );
}

// ============================================================
// PROVIDER
// ============================================================

function getProvider() {
    if (!RPC_URL) {
        throw new Error(
            'RPC_URL nav konfigurēts'
        );
    }

    return new ethers.JsonRpcProvider(
        RPC_URL
    );
}

// ============================================================
// OPERATOR WALLET
// ============================================================
//
// Operator wallet pays gas for Treasury transactions.
//
// It does NOT need to contain the Turbo payment amount.
// Treasury contract supplies the payment amount.
// ============================================================

function getOperatorWallet(provider) {
    if (!OPERATOR_PRIVATE_KEY) {
        throw new Error(
            'OPERATOR_PRIVATE_KEY nav konfigurēts'
        );
    }

    return new ethers.Wallet(
        OPERATOR_PRIVATE_KEY,
        provider
    );
}

// ============================================================
// TURBO CLIENT
// ============================================================

function getTurbo() {
    if (!OPERATOR_PRIVATE_KEY) {
        throw new Error(
            'OPERATOR_PRIVATE_KEY nav konfigurēts'
        );
    }

    const signer =
        new EthereumSigner(
            OPERATOR_PRIVATE_KEY
        );

    return TurboFactory.authenticated({
        signer,

        token:
            TURBO_TOKEN,

        gatewayUrl:
            TURBO_GATEWAY_URL,

        uploadServiceConfig: {
            url:
                TURBO_UPLOAD_URL
        },

        paymentServiceConfig: {
            url:
                TURBO_PAYMENT_URL
        }
    });
}

// ============================================================
// REPOSITORY HASH
// ============================================================

function getRepositoryHash(repoName) {
    if (
        typeof repoName !== 'string' ||
        repoName.trim().length === 0
    ) {
        throw new Error(
            'Repo nosaukums nav derīgs'
        );
    }

    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['string'],
            [repoName]
        )
    );
}

// ============================================================
// REPOSITORY NAME VALIDATION
// ============================================================

function parseRepositoryName(repoName) {
    if (
        typeof repoName !== 'string'
    ) {
        throw new Error(
            'repoName jābūt string'
        );
    }

    const trimmed =
        repoName.trim();

    const parts =
        trimmed.split('/');

    if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
    ) {
        throw new Error(
            'repoName jābūt owner/repository formātā'
        );
    }

    return {
        owner:
            parts[0],

        repo:
            parts[1]
    };
}

// ============================================================
// TURBO PRICE
// ============================================================
//
// Turbo is the source of truth.
//
// The browser MUST NOT provide the authoritative price.
//
// The server calculates the price directly through Turbo.
// ============================================================

async function getTurboPriceForBytes(
    turbo,
    byteCount
) {
    if (
        !Number.isInteger(byteCount)
    ) {
        throw new Error(
            'byteCount jābūt integer'
        );
    }

    if (
        byteCount <= 0
    ) {
        return {
            byteCount,
            costWinc: 0n,
            costEth: '0',
            costWei: 0n
        };
    }

    // --------------------------------------------------------
    // Turbo Winc price
    // --------------------------------------------------------

    const costs =
        await turbo.getUploadCosts({
            bytes: [
                byteCount
            ]
        });

    if (
        !Array.isArray(costs) ||
        costs.length === 0
    ) {
        throw new Error(
            'Turbo getUploadCosts() neatgrieza cenu'
        );
    }

    const firstCost =
        costs[0];

    if (
        !firstCost ||
        firstCost.winc === undefined ||
        firstCost.winc === null
    ) {
        throw new Error(
            'Turbo getUploadCosts() neatgrieza derīgu winc cenu'
        );
    }

    let costWinc;

    try {
        costWinc =
            BigInt(
                String(
                    firstCost.winc
                )
            );
    } catch (error) {
        throw new Error(
            'Turbo winc vērtība nav derīgs integer'
        );
    }

    // --------------------------------------------------------
    // Token price
    // --------------------------------------------------------

    const tokenPriceResponse =
        await turbo.getTokenPriceForBytes({
            byteCount
        });

    if (
        !tokenPriceResponse ||
        tokenPriceResponse.tokenPrice === undefined ||
        tokenPriceResponse.tokenPrice === null
    ) {
        throw new Error(
            'Turbo getTokenPriceForBytes() neatgrieza tokenPrice'
        );
    }

    const costEth =
        String(
            tokenPriceResponse.tokenPrice
        );

    let costWei;

    try {
        costWei =
            ethers.parseEther(
                costEth
            );
    } catch (error) {
        throw new Error(
            'Turbo tokenPrice nav derīgs ETH daudzums: ' +
            costEth
        );
    }

    if (
        costWei < 0n
    ) {
        throw new Error(
            'Turbo cena nevar būt negatīva'
        );
    }

    return {
        byteCount,
        costWinc,
        costEth,
        costWei
    };
}

// ============================================================
// TREASURY BALANCE
// ============================================================

async function getTreasuryBalance(
    provider
) {
    if (
        !TREASURY_ADDRESS
    ) {
        throw new Error(
            'TREASURY_ADDRESS nav konfigurēts'
        );
    }

    const treasury =
        new ethers.Contract(
            TREASURY_ADDRESS,
            TREASURY_ABI,
            provider
        );

    return await treasury.balance();
}

// ============================================================
// TREASURY PAYMENT
// ============================================================

async function payTurboFromTreasury({
    provider,
    amountWei,
    paymentId
}) {
    if (
        typeof amountWei !== 'bigint'
    ) {
        throw new Error(
            'amountWei jābūt bigint'
        );
    }

    if (
        amountWei <= 0n
    ) {
        throw new Error(
            'Treasury payment amount ir 0'
        );
    }

    if (
        !TREASURY_ADDRESS
    ) {
        throw new Error(
            'TREASURY_ADDRESS nav konfigurēts'
        );
    }

    if (
        typeof paymentId !== 'string' ||
        paymentId.length !== 66 ||
        !paymentId.startsWith('0x')
    ) {
        throw new Error(
            'paymentId nav derīgs bytes32'
        );
    }

    const operatorWallet =
        getOperatorWallet(
            provider
        );

    const treasury =
        new ethers.Contract(
            TREASURY_ADDRESS,
            TREASURY_ABI,
            operatorWallet
        );

    const treasuryBalance =
        await treasury.balance();

    if (
        treasuryBalance < amountWei
    ) {
        throw new Error(
            'Treasury nepietiek līdzekļu. ' +
            'Nepieciešams ' +
            ethers.formatEther(
                amountWei
            ) +
            ' ETH, pieejams ' +
            ethers.formatEther(
                treasuryBalance
            ) +
            ' ETH'
        );
    }

    const transaction =
        await treasury.payTurbo(
            amountWei,
            paymentId
        );

    const receipt =
        await transaction.wait();

    if (!receipt) {
        throw new Error(
            'Treasury payment transaction receipt nav saņemts'
        );
    }

    if (
        receipt.status !== 1
    ) {
        throw new Error(
            'Treasury payment transaction failed'
        );
    }

    return {
        hash:
            transaction.hash,

        amountWei,

        amountEth:
            ethers.formatEther(
                amountWei
            ),

        blockNumber:
            receipt.blockNumber
    };
}

// ============================================================
// PAYMENT ID
// ============================================================

function createPaymentId({
    type,
    repoName,
    tokenId
}) {
    return ethers.id(
        [
            'PermRepo',
            type,
            repoName,
            String(tokenId),
            Date.now().toString(),
            crypto
                .randomBytes(16)
                .toString('hex')
        ].join(':')
    );
}

// ============================================================
// CONTENT TYPE
// ============================================================

function getContentType(
    filePath
) {
    const lower =
        String(
            filePath
        ).toLowerCase();

    if (
        lower.endsWith('.json')
    ) {
        return 'application/json';
    }

    if (
        lower.endsWith('.html') ||
        lower.endsWith('.htm')
    ) {
        return 'text/html';
    }

    if (
        lower.endsWith('.css')
    ) {
        return 'text/css';
    }

    if (
        lower.endsWith('.js') ||
        lower.endsWith('.mjs') ||
        lower.endsWith('.cjs')
    ) {
        return 'application/javascript';
    }

    if (
        lower.endsWith('.ts')
    ) {
        return 'application/typescript';
    }

    if (
        lower.endsWith('.md')
    ) {
        return 'text/markdown';
    }

    if (
        lower.endsWith('.txt')
    ) {
        return 'text/plain';
    }

    if (
        lower.endsWith('.xml')
    ) {
        return 'application/xml';
    }

    if (
        lower.endsWith('.csv')
    ) {
        return 'text/csv';
    }

    if (
        lower.endsWith('.svg')
    ) {
        return 'image/svg+xml';
    }

    if (
        lower.endsWith('.png')
    ) {
        return 'image/png';
    }

    if (
        lower.endsWith('.jpg') ||
        lower.endsWith('.jpeg'
        )
    ) {
        return 'image/jpeg';
    }

    if (
        lower.endsWith('.gif')
    ) {
        return 'image/gif';
    }

    if (
        lower.endsWith('.webp')
    ) {
        return 'image/webp';
    }

    if (
        lower.endsWith('.ico')
    ) {
        return 'image/x-icon';
    }

    if (
        lower.endsWith('.pdf')
    ) {
        return 'application/pdf';
    }

    if (
        lower.endsWith('.zip')
    ) {
        return 'application/zip';
    }

    return 'application/octet-stream';
}

// ============================================================
// BLOCKCHAIN CONTRACT FACTORIES
// ============================================================

function getNFTContract(
    provider
) {
    if (
        !NFT_ADDRESS
    ) {
        throw new Error(
            'NFT_ADDRESS nav konfigurēts'
        );
    }

    return new ethers.Contract(
        NFT_ADDRESS,
        NFT_ABI,
        provider
    );
}

function getSubscriptionContract(
    provider
) {
    if (
        !SUBSCRIPTION_ADDRESS
    ) {
        throw new Error(
            'SUBSCRIPTION_ADDRESS nav konfigurēts'
        );
    }

    return new ethers.Contract(
        SUBSCRIPTION_ADDRESS,
        SUBSCRIPTION_ABI,
        provider
    );
}

function getRegistryContract(
    provider
) {
    if (
        !REGISTRY_ADDRESS
    ) {
        throw new Error(
            'REGISTRY_ADDRESS nav konfigurēts'
        );
    }

    return new ethers.Contract(
        REGISTRY_ADDRESS,
        REGISTRY_ABI,
        provider
    );
}

// ============================================================
// ON-CHAIN REPOSITORY STATE
// ============================================================

async function getRepositoryOnChainState({
    provider,
    repoName
}) {
    const repoHash =
        getRepositoryHash(
            repoName
        );

    const nft =
        getNFTContract(
            provider
        );

    const tokenId =
        await nft.repositoryTokens(
            repoHash
        );

    if (
        tokenId === 0n
    ) {
        return {
            exists:
                false,

            tokenId:
                0n
        };
    }

    return {
        exists:
            true,

        tokenId
    };
}

// ============================================================
// VERIFY NFT OWNER
// ============================================================

async function verifyNFTOwner({
    provider,
    tokenId,
    walletAddress
}) {
    const normalizedWallet =
        normalizeAddress(
            walletAddress
        );

    const nft =
        getNFTContract(
            provider
        );

    const owner =
        await nft.ownerOf(
            tokenId
        );

    return (
        owner.toLowerCase() ===
        normalizedWallet.toLowerCase()
    );
}

// ============================================================
// VERIFY SUBSCRIPTION
// ============================================================

async function verifySubscription({
    provider,
    tokenId
}) {
    const subscription =
        getSubscriptionContract(
            provider
        );

    return await subscription.isSubscribed(
        tokenId
    );
}

// ============================================================
// VERIFY REGISTRY
// ============================================================

async function getRegistryRepositoryId({
    provider,
    tokenId
}) {
    const registry =
        getRegistryContract(
            provider
        );

    return await registry.getRepositoryByNFT(
        tokenId
    );
}

// ============================================================
// GET PREVIOUS MANIFEST
// ============================================================

async function getPreviousManifest({
    provider,
    tokenId,
    backupCount
}) {
    const result = {
        previousPaths: {},
        previousHistory: [],
        previousManifestId: null,
        previousBackupNumber: null
    };

    if (
        backupCount <= 0
    ) {
        return result;
    }

    const nft =
        getNFTContract(
            provider
        );

    const manifestURI =
        await nft.getManifestURI(
            tokenId
        );

    if (
        !manifestURI ||
        typeof manifestURI !== 'string'
    ) {
        return result;
    }

    if (
        !manifestURI.startsWith('ar://')
    ) {
        return result;
    }

    const manifestId =
        manifestURI.slice(5);

    if (
        !manifestId
    ) {
        return result;
    }

    result.previousManifestId =
        manifestId;

    const manifestURL =
        buildArweaveRawURL(
            manifestId
        );

    try {
        const response =
            await fetch(
                manifestURL
            );

        if (
            !response.ok
        ) {
            console.warn(
                'Iepriekšējais manifests nav pieejams. HTTP:',
                response.status
            );

            return result;
        }

        const manifest =
            await response.json();

        if (
            manifest &&
            typeof manifest.paths === 'object'
        ) {
            result.previousPaths =
                manifest.paths;
        }

        if (
            manifest &&
            Array.isArray(
                manifest.history
            )
        ) {
            result.previousHistory =
                manifest.history;
        }

        if (
            manifest &&
            manifest.metadata &&
            manifest.metadata.backupNumber !== undefined
        ) {
            result.previousBackupNumber =
                manifest.metadata.backupNumber;
        }

        return result;
    } catch (error) {
        console.warn(
            'Neizdevās iegūt iepriekšējo manifestu:',
            errorMessage(error)
        );

        return result;
    }
}

// ============================================================
// ARWEAVE URL
// ============================================================

function buildArweaveRawURL(
    transactionId
) {
    return (
        ARWEAVE_GATEWAY.replace(
            /\/$/,
            ''
        ) +
        '/raw/' +
        transactionId
    );
}

// ============================================================
// GITHUB API HEADERS
// ============================================================

function getGitHubHeaders(
    githubToken
) {
    return {
        Authorization:
            'Bearer ' +
            githubToken,

        Accept:
            'application/vnd.github.v3+json',

        'X-GitHub-Api-Version':
            '2022-11-28'
    };
}

// ============================================================
// GITHUB FILES
// ============================================================

async function getRepoFiles(
    githubToken,
    owner,
    repo,
    repoPath = ''
) {
    const files = [];

    const encodedPath =
        repoPath
            ? repoPath
                .split('/')
                .map(
                    part =>
                        encodeURIComponent(
                            part
                        )
                )
                .join('/')
            : '';

    const url =
        encodedPath
            ? 'https://api.github.com/repos/' +
              owner +
              '/' +
              repo +
              '/contents/' +
              encodedPath
            : 'https://api.github.com/repos/' +
              owner +
              '/' +
              repo +
              '/contents';

    const response =
        await fetch(
            url,
            {
                headers:
                    getGitHubHeaders(
                        githubToken
                    )
            }
        );

    if (
        !response.ok
    ) {
        throw new Error(
            'GitHub API kļūda: ' +
            response.status
        );
    }

    const contents =
        await response.json();

    if (
        !Array.isArray(contents)
    ) {
        return files;
    }

    for (
        const item of contents
    ) {
        if (
            item.type === 'file'
        ) {
            const size =
                Number(
                    item.size || 0
                );

            if (
                size > MAX_FILE_SIZE
            ) {
                console.warn(
                    'Fails pārsniedz maksimālo izmēru:',
                    item.path
                );

                continue;
            }

            if (
                !item.download_url
            ) {
                continue;
            }

            const fileResponse =
                await fetch(
                    item.download_url,
                    {
                        headers: {
                            Authorization:
                                'Bearer ' +
                                githubToken,

                            Accept:
                                'application/octet-stream'
                        }
                    }
                );

            if (
                !fileResponse.ok
            ) {
                console.warn(
                    'Neizdevās lejupielādēt failu:',
                    item.path,
                    fileResponse.status
                );

                continue;
            }

            const arrayBuffer =
                await fileResponse.arrayBuffer();

            const fileBuffer =
                Buffer.from(
                    arrayBuffer
                );

            const hash =
                crypto
                    .createHash(
                        'sha256'
                    )
                    .update(
                        fileBuffer
                    )
                    .digest('hex');

            files.push({
                path:
                    item.path,

                size:
                    fileBuffer.length,

                content:
                    fileBuffer.toString(
                        'base64'
                    ),

                hash
            });

            continue;
        }

        if (
            item.type === 'dir'
        ) {
            const nestedFiles =
                await getRepoFiles(
                    githubToken,
                    owner,
                    repo,
                    item.path
                );

            files.push(
                ...nestedFiles
            );
        }
    }

    return files;
}

// ============================================================
// CHANGE DETECTION
// ============================================================

function detectChangedFiles({
    currentFiles,
    previousPaths
}) {
    const changedFiles = [];
    const unchangedFiles = {};

    for (
        const file of currentFiles
    ) {
        const previousFile =
            previousPaths[
                file.path
            ];

        const unchanged =
            previousFile &&
            previousFile.id &&
            previousFile.hash &&
            previousFile.hash ===
                file.hash;

        if (
            unchanged
        ) {
            unchangedFiles[
                file.path
            ] = {
                txId:
                    previousFile.id,

                size:
                    file.size,

                hash:
                    file.hash
            };

            continue;
        }

        changedFiles.push(
            file
        );
    }

    return {
        changedFiles,
        unchangedFiles
    };
}

// ============================================================
// FILE BYTE COUNT
// ============================================================

function getFilesByteCount(
    files
) {
    let totalBytes = 0;

    for (
        const file of files
    ) {
        if (
            !file ||
            typeof file.content !== 'string'
        ) {
            throw new Error(
                'Nederīgs faila saturs: ' +
                (
                    file &&
                    file.path
                        ? file.path
                        : 'unknown'
                )
            );
        }

        const buffer =
            Buffer.from(
                file.content,
                'base64'
            );

        if (
            buffer.length <= 0
        ) {
            throw new Error(
                'Fails ir tukšs: ' +
                file.path
            );
        }

        totalBytes +=
            buffer.length;
    }

    return totalBytes;
}

// ============================================================
// BUILD MANIFEST
// ============================================================

function buildManifest({
    repoName,
    backupNumber,
    uploadResults,
    unchangedFiles,
    previousHistory
}) {
    const history =
        Array.isArray(
            previousHistory
        )
            ? [
                ...previousHistory
            ]
            : [];

    const manifest = {
        metadata: {
            repo:
                repoName,

            backupNumber:
                backupNumber,

            timestamp:
                new Date().toISOString(),

            generatedBy:
                'PermRepo v1.0.0'
        },

        manifest:
            'arweave/paths',

        version:
            '0.2.0',

        index: {
            path:
                'README.md'
        },

        paths: {},

        history
    };

    for (
        const file of uploadResults
    ) {
        manifest.paths[
            file.path
        ] = {
            id:
                file.txId,

            hash:
                file.hash,

            url:
                buildArweaveRawURL(
                    file.txId
                )
        };
    }

    for (
        const [
            filePath,
            info
        ] of Object.entries(
            unchangedFiles || {}
        )
    ) {
        if (
            !info ||
            !info.txId
        ) {
            continue;
        }

        manifest.paths[
            filePath
        ] = {
            id:
                info.txId,

            hash:
                info.hash,

            url:
                buildArweaveRawURL(
                    info.txId
                )
        };
    }

    const paths =
        Object.keys(
            manifest.paths
        );

    if (
        paths.length > 0
    ) {
        manifest.index = {
            path:
                manifest.paths[
                    'README.md'
                ]
                    ? 'README.md'
                    : paths[0]
        };
    }

    return manifest;
}

// ============================================================
// TURBO FILE UPLOAD
// ============================================================

async function uploadTurboFile({
    turbo,
    fileBuffer,
    repoName,
    filePath,
    fileHash
}) {
    const result =
        await turbo.uploadFile({
            fileStreamFactory:
                () =>
                    Readable.from(
                        fileBuffer
                    ),

            fileSizeFactory:
                () =>
                    fileBuffer.length,

            dataItemOpts: {
                tags: [
                    {
                        name:
                            'App-Name',

                        value:
                            'PermRepo'
                    },

                    {
                        name:
                            'Repo',

                        value:
                            repoName
                    },

                    {
                        name:
                            'File-Path',

                        value:
                            filePath
                    },

                    {
                        name:
                            'Content-Type',

                        value:
                            getContentType(
                                filePath
                            )
                    },

                    {
                        name:
                            'Content-SHA256',

                        value:
                            fileHash
                    },

                    {
                        name:
                            'Unix-Time',

                        value:
                            String(
                                Math.floor(
                                    Date.now() /
                                        1000
                                )
                            )
                    }
                ]
            }
        });

    if (
        !result ||
        !result.id
    ) {
        throw new Error(
            'Turbo file upload neatgrieza transaction ID: ' +
            filePath
        );
    }

    return result;
}

// ============================================================
// TURBO MANIFEST UPLOAD
// ============================================================

async function uploadTurboManifest({
    turbo,
    manifestBuffer,
    repoName
}) {
    const result =
        await turbo.uploadFile({
            fileStreamFactory:
                () =>
                    Readable.from(
                        manifestBuffer
                    ),

            fileSizeFactory:
                () =>
                    manifestBuffer.length,

            dataItemOpts: {
                tags: [
                    {
                        name:
                            'App-Name',

                        value:
                            'PermRepo'
                    },

                    {
                        name:
                            'Type',

                        value:
                            'path-manifest'
                    },

                    {
                        name:
                            'Repo',

                        value:
                            repoName
                    },

                    {
                        name:
                            'Content-Type',

                        value:
                            'application/x.arweave-manifest+json'
                    },

                    {
                        name:
                            'Unix-Time',

                        value:
                            String(
                                Math.floor(
                                    Date.now() /
                                        1000
                                )
                            )
                    }
                ]
            }
        });

    if (
        !result ||
        !result.id
    ) {
        throw new Error(
            'Turbo manifest upload neatgrieza transaction ID'
        );
    }

    return result;
}

// ============================================================
// CONFIG
// ============================================================

app.get(
    '/api/config',
    (req, res) => {
        res.json({
            chainId:
                CHAIN_ID,

            treasuryAddress:
                TREASURY_ADDRESS,

            nftAddress:
                NFT_ADDRESS,

            subscriptionAddress:
                SUBSCRIPTION_ADDRESS,

            registryAddress:
                REGISTRY_ADDRESS,

            rpcUrl:
                RPC_URL,

            arweaveGateway:
                ARWEAVE_GATEWAY,

            turboToken:
                TURBO_TOKEN
        });
    }
);

// ============================================================
// GITHUB LOGIN
// ============================================================

app.get(
    '/api/github/login',
    (req, res) => {
        if (
            !GITHUB_CLIENT_ID
        ) {
            return res.status(500).json({
                success:
                    false,

                error:
                    'GitHub OAuth nav konfigurēts'
            });
        }

        if (
            !GITHUB_REDIRECT_URI
        ) {
            return res.status(500).json({
                success:
                    false,

                error:
                    'GITHUB_REDIRECT_URI nav konfigurēts'
            });
        }

        const scope =
            'repo read:org';

        const params =
            new URLSearchParams({
                client_id:
                    GITHUB_CLIENT_ID,

                scope,

                redirect_uri:
                    GITHUB_REDIRECT_URI
            });

        return res.redirect(
            'https://github.com/login/oauth/authorize?' +
            params.toString()
        );
    }
);

// ============================================================
// GITHUB CALLBACK
// ============================================================

app.get(
    '/api/github/callback',
    async (req, res) => {
        const code =
            req.query.code;

        if (
            !code
        ) {
            return res.redirect(
                '/backup.html?error=no_code'
            );
        }

        if (
            !GITHUB_CLIENT_ID ||
            !GITHUB_CLIENT_SECRET ||
            !GITHUB_REDIRECT_URI
        ) {
            return res.redirect(
                '/backup.html?error=oauth_config'
            );
        }

        try {
            const tokenResponse =
                await fetch(
                    'https://github.com/login/oauth/access_token',
                    {
                        method:
                            'POST',

                        headers: {
                            'Content-Type':
                                'application/json',

                            Accept:
                                'application/json'
                        },

                        body:
                            JSON.stringify({
                                client_id:
                                    GITHUB_CLIENT_ID,

                                client_secret:
                                    GITHUB_CLIENT_SECRET,

                                code,

                                redirect_uri:
                                    GITHUB_REDIRECT_URI
                            })
                    }
                );

            if (
                !tokenResponse.ok
            ) {
                throw new Error(
                    'GitHub OAuth token HTTP ' +
                    tokenResponse.status
                );
            }

            const tokenData =
                await tokenResponse.json();

            if (
                !tokenData.access_token
            ) {
                return res.redirect(
                    '/backup.html?error=token'
                );
            }

            req.session.githubToken =
                tokenData.access_token;

            const userResponse =
                await fetch(
                    'https://api.github.com/user',
                    {
                        headers:
                            getGitHubHeaders(
                                tokenData.access_token
                            )
                    }
                );

            if (
                !userResponse.ok
            ) {
                throw new Error(
                    'GitHub user API kļūda: ' +
                    userResponse.status
                );
            }

            const userData =
                await userResponse.json();

            req.session.githubUser =
                userData.login;

            req.session.githubAvatar =
                userData.avatar_url ||
                null;

            return res.redirect(
                '/backup.html?auth=success'
            );
        } catch (error) {
            console.error(
                'GitHub OAuth kļūda:',
                error
            );

            return res.redirect(
                '/backup.html?error=oauth'
            );
        }
    }
);

// ============================================================
// GITHUB LOGOUT
// ============================================================

app.get(
    '/api/github/logout',
    (req, res) => {
        req.session.destroy(
            error => {
                if (
                    error
                ) {
                    console.error(
                        'Session destroy kļūda:',
                        error
                    );

                    return res.status(500).json({
                        success:
                            false,

                        error:
                            'Neizdevās izrakstīties'
                    });
                }

                return res.json({
                    success:
                        true
                });
            }
        );
    }
);

// ============================================================
// GITHUB USER
// ============================================================

app.get(
    '/api/github/user',
    (req, res) => {
        if (
            req.session.githubUser
        ) {
            return res.json({
                success:
                    true,

                user:
                    req.session.githubUser,

                avatar:
                    req.session.githubAvatar ||
                    null
            });
        }

        return res.json({
            success:
                false
        });
    }
);

// ============================================================
// GITHUB REPOSITORIES
// ============================================================

app.get(
    '/api/github/repos',
    async (req, res) => {
        const githubToken =
            req.session.githubToken;

        if (
            !githubToken
        ) {
            return res.status(401).json({
                success:
                    false,

                error:
                    'Nav autorizēts caur GitHub'
            });
        }

        try {
            const response =
                await fetch(
                    'https://api.github.com/user/repos?per_page=' +
                    GITHUB_PER_PAGE +
                    '&sort=updated',
                    {
                        headers:
                            getGitHubHeaders(
                                githubToken
                            )
                    }
                );

            if (
                !response.ok
            ) {
                throw new Error(
                    'GitHub API kļūda: ' +
                    response.status
                );
            }

            const repositories =
                await response.json();

            const repoList =
                repositories.map(
                    repo => ({
                        name:
                            repo.full_name,

                        description:
                            repo.description,

                        private:
                            repo.private,

                        language:
                            repo.language,

                        updatedAt:
                            repo.updated_at
                    })
                );

            return res.json({
                success:
                    true,

                repos:
                    repoList
            });
        } catch (error) {
            console.error(
                'GitHub repos kļūda:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

// ============================================================
// CHECK REPOSITORY STATUS
// ============================================================

app.post(
    '/api/check-repo-status',
    async (req, res) => {
        try {
            const {
                repoName,
                walletAddress
            } = req.body;

            if (
                !repoName ||
                !walletAddress
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav repo vai wallet'
                });
            }

            const normalizedWallet =
                normalizeAddress(
                    walletAddress
                );

            const provider =
                getProvider();

            const state =
                await getRepositoryOnChainState({
                    provider,
                    repoName
                });

            let hasNFT =
                false;

            let hasSubscription =
                false;

            let isRegistered =
                false;

            let backupCount =
                0;

            let lastManifestURI =
                '';

            if (
                state.exists
            ) {
                hasNFT =
                    await verifyNFTOwner({
                        provider,
                        tokenId:
                            state.tokenId,
                        walletAddress:
                            normalizedWallet
                    });
            }

            if (
                hasNFT
            ) {
                hasSubscription =
                    await verifySubscription({
                        provider,
                        tokenId:
                            state.tokenId
                    });

                const nft =
                    getNFTContract(
                        provider
                    );

                backupCount =
                    Number(
                        await nft.getBackupCount(
                            state.tokenId
                        )
                    );

                lastManifestURI =
                    await nft.getManifestURI(
                        state.tokenId
                    );

                try {
                    const repoId =
                        await getRegistryRepositoryId({
                            provider,
                            tokenId:
                                state.tokenId
                        });

                    isRegistered =
                        isNonZeroBytes32(
                            repoId
                        );
                } catch (error) {
                    console.warn(
                        'Registry pārbaudes kļūda:',
                        errorMessage(
                            error
                        )
                    );
                }
            }

            return res.json({
                success:
                    true,

                hasNFT,

                hasSubscription,

                isRegistered,

                tokenId:
                    hasNFT
                        ? state.tokenId.toString()
                        : '0',

                backupCount,

                lastManifestURI
            });
        } catch (error) {
            console.error(
                'CHECK REPO STATUS ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

// ============================================================
// PREPARE BACKUP
// ============================================================

app.post(
    '/api/prepare-backup',
    async (req, res) => {
        try {
            const {
                repoName,
                walletAddress
            } = req.body;

            const githubToken =
                req.session.githubToken;

            if (
                !repoName
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav repo nosaukuma'
                });
            }

            if (
                !walletAddress
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav wallet adreses'
                });
            }

            if (
                !githubToken
            ) {
                return res.status(401).json({
                    success:
                        false,

                    error:
                        'Nav GitHub autorizācijas'
                });
            }

            const normalizedWallet =
                normalizeAddress(
                    walletAddress
                );

            const parsedRepo =
                parseRepositoryName(
                    repoName
                );

            const provider =
                getProvider();

            const state =
                await getRepositoryOnChainState({
                    provider,
                    repoName
                });

            if (
                !state.exists
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav NFT šim repo'
                });
            }

            const ownsNFT =
                await verifyNFTOwner({
                    provider,
                    tokenId:
                        state.tokenId,
                    walletAddress:
                        normalizedWallet
                });

            if (
                !ownsNFT
            ) {
                return res.status(403).json({
                    success:
                        false,

                    error:
                        'NFT nepieder šai adresei'
                });
            }

            const subscribed =
                await verifySubscription({
                    provider,
                    tokenId:
                        state.tokenId
                });

            if (
                !subscribed
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav aktīva abonementa'
                });
            }

            const repoId =
                await getRegistryRepositoryId({
                    provider,
                    tokenId:
                        state.tokenId
                });

            if (
                repoId === ethers.ZeroHash
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Repo nav reģistrēts Registry'
                });
            }

            const nft =
                getNFTContract(
                    provider
                );

            const backupCount =
                Number(
                    await nft.getBackupCount(
                        state.tokenId
                    )
                );

            const previous =
                await getPreviousManifest({
                    provider,
                    tokenId:
                        state.tokenId,
                    backupCount
                });

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    parsedRepo.owner,
                    parsedRepo.repo
                );

            if (
                currentFiles.length === 0
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav failu repo'
                });
            }

            const {
                changedFiles,
                unchangedFiles
            } =
                detectChangedFiles({
                    currentFiles,

                    previousPaths:
                        previous.previousPaths
                });

            const totalBytes =
                getFilesByteCount(
                    changedFiles
                );

            // ------------------------------------------------
            // No changes
            // ------------------------------------------------

            if (
                totalBytes === 0
            ) {
                const treasuryBalance =
                    await getTreasuryBalance(
                        provider
                    );

                return res.json({
                    success:
                        true,

                    repoName,

                    tokenId:
                        state.tokenId.toString(),

                    files:
                        [],

                    unchangedFiles,

                    previousHistory:
                        previous.previousHistory,

                    previousManifestId:
                        previous.previousManifestId,

                    previousBackupNumber:
                        previous.previousBackupNumber,

                    fileCount:
                        0,

                    totalBytes:
                        0,

                    costWinc:
                        '0',

                    costEth:
                        '0',

                    costWei:
                        '0',

                    treasuryBalance:
                        treasuryBalance.toString(),

                    hasEnoughTreasury:
                        true,

                    hasPreviousBackup:
                        backupCount > 0,

                    backupCount,

                    message:
                        'Nav izmaiņu'
                });
            }

            // ------------------------------------------------
            // Turbo price
            // ------------------------------------------------

            const turbo =
                getTurbo();

            const filePrice =
                await getTurboPriceForBytes(
                    turbo,
                    totalBytes
                );

            const treasuryBalance =
                await getTreasuryBalance(
                    provider
                );

            const hasEnoughTreasury =
                treasuryBalance >=
                filePrice.costWei;

            return res.json({
                success:
                    true,

                repoName,

                tokenId:
                    state.tokenId.toString(),

                files:
                    changedFiles.map(
                        file => ({
                            path:
                                file.path,

                            size:
                                file.size,

                            hash:
                                file.hash,

                            content:
                                file.content
                        })
                    ),

                unchangedFiles,

                previousHistory:
                    previous.previousHistory,

                previousManifestId:
                    previous.previousManifestId,

                previousBackupNumber:
                    previous.previousBackupNumber,

                fileCount:
                    changedFiles.length,

                totalBytes,

                costWinc:
                    filePrice.costWinc.toString(),

                costEth:
                    filePrice.costEth,

                costWei:
                    filePrice.costWei.toString(),

                treasuryBalance:
                    treasuryBalance.toString(),

                hasEnoughTreasury,

                hasPreviousBackup:
                    backupCount > 0,

                backupCount,

                turboToken:
                    TURBO_TOKEN
            });
        } catch (error) {
            console.error(
                'BACKUP PREPARE ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

// ============================================================
// EXECUTE BACKUP
// ============================================================

app.post(
    '/api/execute-backup',
    async (req, res) => {
        try {
            const {
                repoName,
                files,
                unchangedFiles,
                tokenId,
                walletAddress,
                previousHistory,
                previousManifestId,
                previousBackupNumber
            } = req.body;

            // ------------------------------------------------
            // Basic validation
            // ------------------------------------------------

            if (
                !repoName
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav repoName'
                });
            }

            if (
                !walletAddress
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav walletAddress'
                });
            }

            if (
                !Array.isArray(files)
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'files nav masīvs'
                });
            }

            if (
                !tokenId
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav tokenId'
                });
            }

            const parsedRepo =
                parseRepositoryName(
                    repoName
                );

            const normalizedWallet =
                normalizeAddress(
                    walletAddress
                );

            const numericTokenId =
                BigInt(
                    String(tokenId)
                );

            if (
                numericTokenId <= 0n
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'tokenId nav derīgs'
                });
            }

            // ------------------------------------------------
            // Provider
            // ------------------------------------------------

            const provider =
                getProvider();

            // ------------------------------------------------
            // Verify repository
            // ------------------------------------------------

            const state =
                await getRepositoryOnChainState({
                    provider,
                    repoName
                });

            if (
                !state.exists
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Repo NFT vairs nepastāv'
                });
            }

            if (
                state.tokenId !==
                numericTokenId
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'tokenId neatbilst on-chain NFT'
                });
            }

            // ------------------------------------------------
            // Verify owner
            // ------------------------------------------------

            const ownsNFT =
                await verifyNFTOwner({
                    provider,
                    tokenId:
                        numericTokenId,
                    walletAddress:
                        normalizedWallet
                });

            if (
                !ownsNFT
            ) {
                return res.status(403).json({
                    success:
                        false,

                    error:
                        'NFT nepieder wallet adresei'
                });
            }

            // ------------------------------------------------
            // Verify subscription
            // ------------------------------------------------

            const subscribed =
                await verifySubscription({
                    provider,
                    tokenId:
                        numericTokenId
                });

            if (
                !subscribed
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Abonements vairs nav aktīvs'
                });
            }

            // ------------------------------------------------
            // Verify registry
            // ------------------------------------------------

            const repoId =
                await getRegistryRepositoryId({
                    provider,
                    tokenId:
                        numericTokenId
                });

            if (
                repoId === ethers.ZeroHash
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Repo nav reģistrēts Registry'
                });
            }

            // ------------------------------------------------
            // Validate files
            // ------------------------------------------------

            for (
                const file of files
            ) {
                if (
                    !file ||
                    typeof file.path !== 'string' ||
                    !file.path ||
                    typeof file.content !== 'string'
                ) {
                    return res.status(400).json({
                        success:
                            false,

                        error:
                            'Nederīgs fails backup pieprasījumā'
                    });
                }
            }

            const totalBytes =
                getFilesByteCount(
                    files
                );

            if (
                totalBytes <= 0
            ) {
                return res.status(400).json({
                    success:
                        false,

                    error:
                        'Nav mainītu failu augšupielādei'
                });
            }

            // ------------------------------------------------
            // Turbo
            // ------------------------------------------------

            const turbo =
                getTurbo();

            // ------------------------------------------------
            // IMPORTANT:
            // Recalculate authoritative price.
            // Browser price is never trusted.
            // ------------------------------------------------

            const filePrice =
                await getTurboPriceForBytes(
                    turbo,
                    totalBytes
                );

            console.log(
                'Turbo file price:',
                {
                    bytes:
                        totalBytes,

                    winc:
                        filePrice.costWinc.toString(),

                    eth:
                        filePrice.costEth,

                    wei:
                        filePrice.costWei.toString()
                }
            );

            // ------------------------------------------------
            // Verify Treasury before spending
            // ------------------------------------------------

            const treasuryBalanceBeforeFiles =
                await getTreasuryBalance(
                    provider
                );

            if (
                treasuryBalanceBeforeFiles <
                filePrice.costWei
            ) {
                return res.status(402).json({
                    success:
                        false,

                    error:
                        'Treasury nepietiek līdzekļu failu uploadam',

                    requiredWei:
                        filePrice.costWei.toString(),

                    treasuryBalance:
                        treasuryBalanceBeforeFiles.toString()
                });
            }

            // ------------------------------------------------
            // File payment
            // ------------------------------------------------

            const filePaymentId =
                createPaymentId({
                    type:
                        'files',

                    repoName,

                    tokenId:
                        numericTokenId
                });

            const filePayment =
                await payTurboFromTreasury({
                    provider,

                    amountWei:
                        filePrice.costWei,

                    paymentId:
                        filePaymentId
                });

            console.log(
                'Treasury file payment:',
                filePayment
            );

            // ------------------------------------------------
            // Give Turbo payment time to propagate
            // ------------------------------------------------

            if (
                TURBO_PAYMENT_WAIT_MS > 0
            ) {
                await sleep(
                    TURBO_PAYMENT_WAIT_MS
                );
            }

            // ------------------------------------------------
            // Upload files
            // ------------------------------------------------

            const uploadResults = [];

            for (
                const file of files
            ) {
                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                if (
                    fileBuffer.length <= 0
                ) {
                    throw new Error(
                        'Fails ir tukšs: ' +
                        file.path
                    );
                }

                const calculatedHash =
                    crypto
                        .createHash(
                            'sha256'
                        )
                        .update(
                            fileBuffer
                        )
                        .digest('hex');

                if (
                    file.hash &&
                    file.hash !== calculatedHash
                ) {
                    throw new Error(
                        'Faila hash neatbilst saturam: ' +
                        file.path
                    );
                }

                const result =
                    await uploadTurboFile({
                        turbo,

                        fileBuffer,

                        repoName,

                        filePath:
                            file.path,

                        fileHash:
                            calculatedHash
                    });

                uploadResults.push({
                    path:
                        file.path,

                    txId:
                        result.id,

                    size:
                        fileBuffer.length,

                    hash:
                        calculatedHash
                });
            }

            // ------------------------------------------------
            // Current on-chain backup count
            // ------------------------------------------------

            const nft =
                getNFTContract(
                    provider
                );

            const currentBackupCount =
                Number(
                    await nft.getBackupCount(
                        numericTokenId
                    )
                );

            const newBackupNumber =
                currentBackupCount + 1;

            // ------------------------------------------------
            // Build history
            // ------------------------------------------------

            const history =
                Array.isArray(
                    previousHistory
                )
                    ? [
                        ...previousHistory
                    ]
                    : [];

            if (
                previousManifestId
            ) {
                history.push({
                    backupNumber:
                        previousBackupNumber ||
                        history.length,

                    manifestId:
                        previousManifestId,

                    url:
                        buildArweaveRawURL(
                            previousManifestId
                        )
                });
            }

            // ------------------------------------------------
            // Build manifest
            // ------------------------------------------------

            const manifest =
                buildManifest({
                    repoName,

                    backupNumber:
                        newBackupNumber,

                    uploadResults,

                    unchangedFiles:
                        unchangedFiles || {},

                    previousHistory:
                        history
                });

            const manifestBuffer =
                Buffer.from(
                    JSON.stringify(
                        manifest
                    ),
                    'utf8'
                );

            const manifestBytes =
                manifestBuffer.length;

            // ------------------------------------------------
            // Manifest price
            // ------------------------------------------------

            const manifestPrice =
                await getTurboPriceForBytes(
                    turbo,
                    manifestBytes
                );

            console.log(
                'Turbo manifest price:',
                {
                    bytes:
                        manifestBytes,

                    winc:
                        manifestPrice.costWinc.toString(),

                    eth:
                        manifestPrice.costEth,

                    wei:
                        manifestPrice.costWei.toString()
                }
            );

            // ------------------------------------------------
            // Verify Treasury for manifest
            // ------------------------------------------------

            const treasuryBalanceBeforeManifest =
                await getTreasuryBalance(
                    provider
                );

            if (
                treasuryBalanceBeforeManifest <
                manifestPrice.costWei
            ) {
                throw new Error(
                    'Treasury nepietiek līdzekļu manifesta uploadam'
                );
            }

            // ------------------------------------------------
            // Manifest payment
            // ------------------------------------------------

            const manifestPaymentId =
                createPaymentId({
                    type:
                        'manifest',

                    repoName,

                    tokenId:
                        numericTokenId
                });

            const manifestPayment =
                await payTurboFromTreasury({
                    provider,

                    amountWei:
                        manifestPrice.costWei,

                    paymentId:
                        manifestPaymentId
                });

            console.log(
                'Treasury manifest payment:',
                manifestPayment
            );

            // ------------------------------------------------
            // Wait for manifest payment
            // ------------------------------------------------

            if (
                TURBO_PAYMENT_WAIT_MS > 0
            ) {
                await sleep(
                    TURBO_PAYMENT_WAIT_MS
                );
            }

            // ------------------------------------------------
            // Upload manifest
            // ------------------------------------------------

            const manifestResult =
                await uploadTurboManifest({
                    turbo,

                    manifestBuffer,

                    repoName
                });

            // ------------------------------------------------
            // Final price
            // ------------------------------------------------

            const totalPaymentWei =
                filePrice.costWei +
                manifestPrice.costWei;

            const totalPaymentEth =
                ethers.formatEther(
                    totalPaymentWei
                );

            const totalPaymentWinc =
                filePrice.costWinc +
                manifestPrice.costWinc;

            // ------------------------------------------------
            // Response
            // ------------------------------------------------

            return res.json({
                success:
                    true,

                repoName,

                tokenId:
                    numericTokenId.toString(),

                backupNumber:
                    newBackupNumber,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                unchangedFiles:
                    unchangedFiles || {},

                costEth:
                    totalPaymentEth,

                costWei:
                    totalPaymentWei.toString(),

                costWinc:
                    totalPaymentWinc.toString(),

                fileCostEth:
                    filePrice.costEth,

                fileCostWei:
                    filePrice.costWei.toString(),

                fileCostWinc:
                    filePrice.costWinc.toString(),

                manifestCostEth:
                    manifestPrice.costEth,

                manifestCostWei:
                    manifestPrice.costWei.toString(),

                manifestCostWinc:
                    manifestPrice.costWinc.toString(),

                fileBytes:
                    totalBytes,

                manifestBytes,

                paymentTx:
                    filePayment.hash,

                manifestPaymentTx:
                    manifestPayment.hash,

                history:
                    manifest.history
            });
        } catch (error) {
            console.error(
                'BACKUP EXECUTE ERROR:',
                error
            );

            return res.status(500).json({
                success:
                    false,

                error:
                    errorMessage(
                        error
                    )
            });
        }
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    '/api/health',
    async (req, res) => {
        let chainId = null;

        try {
            if (
                RPC_URL
            ) {
                const provider =
                    getProvider();

                const network =
                    await provider.getNetwork();

                chainId =
                    network.chainId.toString();
            }
        } catch (error) {
            chainId =
                null;
        }

        return res.json({
            status:
                'ok',

            chainId,

            configured: {
                rpc:
                    Boolean(
                        RPC_URL
                    ),

                operatorKey:
                    Boolean(
                        OPERATOR_PRIVATE_KEY
                    ),

                treasury:
                    Boolean(
                        TREASURY_ADDRESS
                    ),

                nft:
                    Boolean(
                        NFT_ADDRESS
                    ),

                subscription:
                    Boolean(
                        SUBSCRIPTION_ADDRESS
                    ),

                registry:
                    Boolean(
                        REGISTRY_ADDRESS
                    ),

                githubOAuth:
                    Boolean(
                        GITHUB_CLIENT_ID &&
                        GITHUB_CLIENT_SECRET &&
                        GITHUB_REDIRECT_URI
                    ),

                turboToken:
                    TURBO_TOKEN,

                turboGateway:
                    TURBO_GATEWAY_URL,

                turboUpload:
                    TURBO_UPLOAD_URL,

                turboPayment:
                    TURBO_PAYMENT_URL
            }
        });
    }
);

// ============================================================
// FRONTEND FALLBACK
// ============================================================
//
// Express 5 can reject old path-to-regexp '*' syntax.
// We therefore use a regular expression instead of:
//
// app.get('*', ...)
//
// ============================================================

app.get(
    /.*/,
    (req, res) => {
        if (
            req.path.startsWith('/api/')
        ) {
            return res.status(404).json({
                success:
                    false,

                error:
                    'API endpoint nav atrasts'
            });
        }

        return res.sendFile(
            path.join(
                __dirname,
                'public',
                'backup.html'
            )
        );
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            '========================================'
        );

        console.log(
            'PermRepo serveris palaists'
        );

        console.log(
            'Port:',
            PORT
        );

        console.log(
            '========================================'
        );

        console.log(
            'Turbo token:',
            TURBO_TOKEN
        );

        console.log(
            'Turbo gateway:',
            TURBO_GATEWAY_URL
        );

        console.log(
            'Turbo upload:',
            TURBO_UPLOAD_URL
        );

        console.log(
            'Turbo payment:',
            TURBO_PAYMENT_URL
        );

        console.log(
            'Treasury:',
            TREASURY_ADDRESS
        );

        console.log(
            'NFT:',
            NFT_ADDRESS
        );

        console.log(
            'Subscription:',
            SUBSCRIPTION_ADDRESS
        );

        console.log(
            'Registry:',
            REGISTRY_ADDRESS
        );

        console.log(
            '========================================'
        );
    }
);

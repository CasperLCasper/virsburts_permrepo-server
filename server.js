```javascript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { Readable } from 'stream';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// ENVIRONMENT
// ============================================================

const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const NFT_ADDRESS = process.env.NFT_ADDRESS;
const SUBSCRIPTION_ADDRESS = process.env.SUBSCRIPTION_ADDRESS;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;

const ARWEAVE_GATEWAY =
    process.env.ARWEAVE_GATEWAY || 'https://ar-io.dev';

const CHAIN_ID =
    process.env.CHAIN_ID || '0x14a34';

const GITHUB_CLIENT_ID =
    process.env.GITHUB_CLIENT_ID;

const GITHUB_CLIENT_SECRET =
    process.env.GITHUB_CLIENT_SECRET;

const GITHUB_REDIRECT_URI =
    process.env.GITHUB_REDIRECT_URI;

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString('hex');

const TURBO_TOKEN =
    process.env.TURBO_TOKEN || 'base-eth';

const TURBO_UPLOAD_URL =
    process.env.TURBO_UPLOAD_URL ||
    'https://upload.services.ar-io.dev';

const TURBO_PAYMENT_URL =
    process.env.TURBO_PAYMENT_URL ||
    'https://payment.services.ar-io.dev';

// ============================================================
// CONTRACT ABIs
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
// EXPRESS
// ============================================================

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie: {
            secure: false,
            httpOnly: true,
            maxAge: 3600000
        }
    })
);

// ============================================================
// PROVIDER / WALLET
// ============================================================

function getProvider() {
    if (!RPC_URL) {
        throw new Error('RPC_URL nav konfigurēts');
    }

    return new ethers.JsonRpcProvider(RPC_URL);
}

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
// TURBO
// ============================================================

function getTurbo() {
    if (!OPERATOR_PRIVATE_KEY) {
        throw new Error(
            'OPERATOR_PRIVATE_KEY nav konfigurēts'
        );
    }

    return TurboFactory.authenticated({
        signer: new EthereumSigner(OPERATOR_PRIVATE_KEY),
        token: TURBO_TOKEN,

        gatewayUrl: 'https://sepolia.base.org',

        uploadServiceConfig: {
            url: TURBO_UPLOAD_URL
        },

        paymentServiceConfig: {
            url: TURBO_PAYMENT_URL
        }
    });
}

// ============================================================
// ERROR HELPER
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

// ============================================================
// REPOSITORY HASH
// ============================================================

function getRepositoryHash(repoName) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['string'],
            [repoName]
        )
    );
}

// ============================================================
// TURBO PRICE HELPERS
// ============================================================

/**
 * Normalizē Turbo SDK tokenPrice uz wei.
 *
 * Turbo SDK atkarībā no versijas / atbildes formas
 * var atgriezt bigint, string vai number.
 */
function normalizeTokenPriceToWei(tokenPrice) {
    if (tokenPrice === undefined || tokenPrice === null) {
        throw new Error(
            'Turbo SDK neatgrieza tokenPrice'
        );
    }

    if (typeof tokenPrice === 'bigint') {
        return tokenPrice;
    }

    if (typeof tokenPrice === 'string') {
        const value = tokenPrice.trim();

        if (!value) {
            throw new Error(
                'Turbo SDK atgrieza tukšu tokenPrice'
            );
        }

        /*
         * Ja jau ir vesels skaitlis, pieņemam, ka
         * tas ir wei.
         *
         * Ja ir decimāldaļa, pieņemam ETH daudzumu.
         */
        if (/^\d+$/.test(value)) {
            return BigInt(value);
        }

        return ethers.parseEther(value);
    }

    if (typeof tokenPrice === 'number') {
        if (!Number.isFinite(tokenPrice)) {
            throw new Error(
                'Turbo SDK atgrieza nederīgu tokenPrice'
            );
        }

        return ethers.parseEther(
            tokenPrice.toString()
        );
    }

    /*
     * Atbalsts objektiem, kas uzvedas kā bigint/string.
     */
    if (
        typeof tokenPrice.toString === 'function'
    ) {
        const value = tokenPrice.toString();

        if (/^\d+$/.test(value)) {
            return BigInt(value);
        }

        return ethers.parseEther(value);
    }

    throw new Error(
        'Neatpazīts Turbo tokenPrice formāts'
    );
}

/**
 * Iegūst Turbo SDK cenu konkrētam byte daudzumam.
 *
 * Šī funkcija NEVEIC maksājumu.
 * Tā tikai iegūst cenu.
 */
async function quoteTurbo(turbo, byteCount) {
    const bytes = Number(byteCount);

    if (!Number.isFinite(bytes) || bytes < 0) {
        throw new Error(
            `Nederīgs byteCount: ${byteCount}`
        );
    }

    if (bytes === 0) {
        return {
            bytes: 0,
            winc: 0n,
            wei: 0n,
            eth: '0'
        };
    }

    const costs =
        await turbo.getUploadCosts({
            bytes: [bytes]
        });

    if (
        !Array.isArray(costs) ||
        costs.length === 0
    ) {
        throw new Error(
            'Turbo SDK neatgrieza upload cost'
        );
    }

    const firstCost = costs[0];

    if (
        !firstCost ||
        firstCost.winc === undefined
    ) {
        throw new Error(
            'Turbo SDK upload cost nesatur winc'
        );
    }

    const winc =
        BigInt(String(firstCost.winc));

    const priceResponse =
        await turbo.getTokenPriceForBytes({
            byteCount: bytes
        });

    if (
        !priceResponse ||
        priceResponse.tokenPrice === undefined
    ) {
        throw new Error(
            'Turbo SDK neatgrieza tokenPrice'
        );
    }

    const wei =
        normalizeTokenPriceToWei(
            priceResponse.tokenPrice
        );

    return {
        bytes,
        winc,
        wei,
        eth: ethers.formatEther(wei)
    };
}

// ============================================================
// TREASURY BALANCE
// ============================================================

async function getTreasuryBalance(provider) {
    if (!TREASURY_ADDRESS) {
        return 0n;
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

async function payTurboFromTreasury(
    provider,
    amountWei,
    paymentId
) {
    if (amountWei <= 0n) {
        throw new Error(
            'payTurbo netiek izsaukts ar nulles summu'
        );
    }

    const operatorWallet =
        getOperatorWallet(provider);

    const treasury =
        new ethers.Contract(
            TREASURY_ADDRESS,
            TREASURY_ABI,
            operatorWallet
        );

    const treasuryBalance =
        await treasury.balance();

    if (treasuryBalance < amountWei) {
        throw new Error(
            `Treasury bilance nepietiekama. ` +
            `Nepieciešams ${ethers.formatEther(amountWei)} ETH, ` +
            `pieejams ${ethers.formatEther(treasuryBalance)} ETH`
        );
    }

    const tx =
        await treasury.payTurbo(
            amountWei,
            paymentId
        );

    const receipt =
        await tx.wait();

    console.log(
        '✅ Treasury payTurbo veiksmīgs:',
        tx.hash
    );

    return {
        hash: tx.hash,
        receipt
    };
}

// ============================================================
// CONFIG
// ============================================================

app.get(
    '/api/config',
    (req, res) => {
        res.json({
            chainId: CHAIN_ID,
            treasuryAddress: TREASURY_ADDRESS,
            nftAddress: NFT_ADDRESS,
            subscriptionAddress:
                SUBSCRIPTION_ADDRESS,
            registryAddress:
                REGISTRY_ADDRESS,
            rpcUrl: RPC_URL,
            arweaveGateway:
                ARWEAVE_GATEWAY,
            turboToken: TURBO_TOKEN
        });
    }
);

// ============================================================
// GITHUB LOGIN
// ============================================================

app.get(
    '/api/github/login',
    (req, res) => {
        if (!GITHUB_CLIENT_ID) {
            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        'GitHub OAuth nav konfigurēts'
                });
        }

        if (!GITHUB_REDIRECT_URI) {
            return res
                .status(500)
                .json({
                    success: false,
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

        res.redirect(
            `https://github.com/login/oauth/authorize?${params.toString()}`
        );
    }
);

// ============================================================
// GITHUB CALLBACK
// ============================================================

app.get(
    '/api/github/callback',
    async (req, res) => {
        const { code } = req.query;

        if (!code) {
            return res.redirect(
                '/backup.html?error=no_code'
            );
        }

        try {
            const tokenResponse =
                await fetch(
                    'https://github.com/login/oauth/access_token',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json',
                            Accept:
                                'application/json'
                        },
                        body: JSON.stringify({
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

            if (!tokenResponse.ok) {
                throw new Error(
                    `GitHub OAuth token HTTP ${tokenResponse.status}`
                );
            }

            const tokenData =
                await tokenResponse.json();

            if (!tokenData.access_token) {
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
                        headers: {
                            Authorization:
                                `Bearer ${tokenData.access_token}`,
                            Accept:
                                'application/vnd.github.v3+json'
                        }
                    }
                );

            if (!userResponse.ok) {
                throw new Error(
                    `GitHub user API kļūda: ${userResponse.status}`
                );
            }

            const userData =
                await userResponse.json();

            req.session.githubUser =
                userData.login;

            req.session.githubAvatar =
                userData.avatar_url;

            res.redirect(
                '/backup.html?auth=success'
            );
        } catch (error) {
            console.error(
                'OAuth kļūda:',
                error
            );

            res.redirect(
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
        req.session.destroy(() => {
            res.json({
                success: true
            });
        });
    }
);

// ============================================================
// GITHUB USER
// ============================================================

app.get(
    '/api/github/user',
    (req, res) => {
        if (req.session.githubUser) {
            return res.json({
                success: true,
                user:
                    req.session.githubUser,
                avatar:
                    req.session.githubAvatar ||
                    null
            });
        }

        res.json({
            success: false
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

        if (!githubToken) {
            return res
                .status(401)
                .json({
                    success: false,
                    error:
                        'Nav autorizēts caur GitHub'
                });
        }

        try {
            const response =
                await fetch(
                    'https://api.github.com/user/repos?per_page=100&sort=updated',
                    {
                        headers: {
                            Authorization:
                                `Bearer ${githubToken}`,
                            Accept:
                                'application/vnd.github.v3+json'
                        }
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `GitHub API kļūda: ${response.status}`
                );
            }

            const repos =
                await response.json();

            const repoList =
                repos.map(repo => ({
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
                }));

            res.json({
                success: true,
                repos: repoList
            });
        } catch (error) {
            res
                .status(500)
                .json({
                    success: false,
                    error:
                        errorMessage(error)
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
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav repo vai wallet'
                    });
            }

            const provider =
                getProvider();

            const repoHash =
                getRepositoryHash(
                    repoName
                );

            const nftContract =
                new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

            const tokenId =
                await nftContract.repositoryTokens(
                    repoHash
                );

            let hasNFT = false;
            let hasSubscription = false;
            let isRegistered = false;
            let backupCount = 0;
            let lastManifestURI = '';

            if (tokenId !== 0n) {
                const nftOwner =
                    await nftContract.ownerOf(
                        tokenId
                    );

                if (
                    nftOwner.toLowerCase() ===
                    walletAddress.toLowerCase()
                ) {
                    hasNFT = true;
                }
            }

            if (hasNFT) {
                const subscriptionContract =
                    new ethers.Contract(
                        SUBSCRIPTION_ADDRESS,
                        SUBSCRIPTION_ABI,
                        provider
                    );

                hasSubscription =
                    await subscriptionContract.isSubscribed(
                        tokenId
                    );

                backupCount =
                    Number(
                        await nftContract.getBackupCount(
                            tokenId
                        )
                    );

                lastManifestURI =
                    await nftContract.getManifestURI(
                        tokenId
                    );

                const registryContract =
                    new ethers.Contract(
                        REGISTRY_ADDRESS,
                        REGISTRY_ABI,
                        provider
                    );

                try {
                    const repoId =
                        await registryContract.getRepositoryByNFT(
                            tokenId
                        );

                    isRegistered =
                        repoId !==
                        ethers.ZeroHash;
                } catch (error) {
                    console.warn(
                        'Registry pārbaudes kļūda:',
                        errorMessage(error)
                    );
                }
            }

            res.json({
                success: true,
                hasNFT,
                hasSubscription,
                isRegistered,
                tokenId:
                    hasNFT
                        ? tokenId.toString()
                        : '0',
                backupCount,
                lastManifestURI
            });
        } catch (error) {
            res
                .status(500)
                .json({
                    success: false,
                    error:
                        errorMessage(error)
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

            if (!repoName) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav repo nosaukuma'
                    });
            }

            if (!walletAddress) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav wallet adreses'
                    });
            }

            if (!githubToken) {
                return res
                    .status(401)
                    .json({
                        success: false,
                        error:
                            'Nav GitHub autorizācijas'
                    });
            }

            const repoParts =
                repoName.split('/');

            if (repoParts.length !== 2) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Repo jābūt owner/repository formātā'
                    });
            }

            const provider =
                getProvider();

            const repoHash =
                getRepositoryHash(
                    repoName
                );

            const nftContract =
                new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

            const tokenId =
                await nftContract.repositoryTokens(
                    repoHash
                );

            if (tokenId === 0n) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav NFT šim repo'
                    });
            }

            const nftOwner =
                await nftContract.ownerOf(
                    tokenId
                );

            if (
                nftOwner.toLowerCase() !==
                walletAddress.toLowerCase()
            ) {
                return res
                    .status(403)
                    .json({
                        success: false,
                        error:
                            'NFT nepieder šai adresei'
                    });
            }

            const subscriptionContract =
                new ethers.Contract(
                    SUBSCRIPTION_ADDRESS,
                    SUBSCRIPTION_ABI,
                    provider
                );

            const subscribed =
                await subscriptionContract.isSubscribed(
                    tokenId
                );

            if (!subscribed) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav aktīva abonementa'
                    });
            }

            const registryContract =
                new ethers.Contract(
                    REGISTRY_ADDRESS,
                    REGISTRY_ABI,
                    provider
                );

            const repoId =
                await registryContract.getRepositoryByNFT(
                    tokenId
                );

            if (
                repoId ===
                ethers.ZeroHash
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Repo nav reģistrēts Registry'
                    });
            }

            const backupCount =
                Number(
                    await nftContract.getBackupCount(
                        tokenId
                    )
                );

            // ====================================================
            // PREVIOUS MANIFEST
            // ====================================================

            let previousPaths = {};
            let previousHistory = [];
            let previousManifestId = null;
            let previousBackupNumber = null;

            if (backupCount > 0) {
                const manifestURI =
                    await nftContract.getManifestURI(
                        tokenId
                    );

                console.log(
                    'Iepriekšējais manifesta URI:',
                    manifestURI
                );

                if (
                    manifestURI &&
                    manifestURI.startsWith(
                        'ar://'
                    )
                ) {
                    previousManifestId =
                        manifestURI.slice(5);

                    try {
                        const manifestResponse =
                            await fetch(
                                `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
                            );

                        if (
                            manifestResponse.ok
                        ) {
                            const text =
                                await manifestResponse.text();

                            let previousManifest;

                            try {
                                previousManifest =
                                    JSON.parse(text);
                            } catch (parseError) {
                                console.warn(
                                    'Iepriekšējais manifests nav JSON:',
                                    errorMessage(
                                        parseError
                                    )
                                );

                                previousManifest =
                                    null;
                            }

                            if (
                                previousManifest &&
                                previousManifest.paths
                            ) {
                                previousPaths =
                                    previousManifest.paths;
                            }

                            if (
                                previousManifest &&
                                Array.isArray(
                                    previousManifest.history
                                )
                            ) {
                                previousHistory =
                                    previousManifest.history;
                            }

                            if (
                                previousManifest &&
                                previousManifest.metadata &&
                                previousManifest.metadata.backupNumber !==
                                    undefined
                            ) {
                                previousBackupNumber =
                                    previousManifest.metadata.backupNumber;
                            }

                            console.log(
                                'Iepriekšējais manifests iegūts:',
                                Object.keys(
                                    previousPaths
                                ).length,
                                'faili,',
                                previousHistory.length,
                                'vēstures ieraksti'
                            );
                        }
                    } catch (error) {
                        console.warn(
                            'Neizdevās iegūt iepriekšējo manifestu:',
                            errorMessage(error)
                        );
                    }
                }
            }

            // ====================================================
            // CURRENT GITHUB FILES
            // ====================================================

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    repoParts[0],
                    repoParts[1]
                );

            if (
                currentFiles.length === 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav failu repo'
                    });
            }

            // ====================================================
            // INCREMENTAL COMPARISON
            // ====================================================

            const changedFiles = [];
            const unchangedFiles = {};

            for (
                const file of currentFiles
            ) {
                const previousFile =
                    previousPaths[
                        file.path
                    ];

                if (
                    previousFile &&
                    previousFile.id &&
                    previousFile.hash &&
                    previousFile.hash ===
                        file.hash
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
                } else {
                    changedFiles.push(
                        file
                    );
                }
            }

            const totalBytes =
                changedFiles.reduce(
                    (sum, file) =>
                        sum +
                        Number(
                            file.size || 0
                        ),
                    0
                );

            // ====================================================
            // NO CHANGES
            // ====================================================

            if (totalBytes === 0) {
                return res.json({
                    success: true,
                    repoName,
                    tokenId:
                        tokenId.toString(),
                    files: [],
                    unchangedFiles,
                    previousHistory,
                    previousManifestId,
                    previousBackupNumber,
                    fileCount: 0,
                    totalBytes: 0,
                    costWinc: '0',
                    costEth: '0',
                    treasuryBalance:
                        (
                            await getTreasuryBalance(
                                provider
                            )
                        ).toString(),
                    hasEnoughTreasury:
                        true,
                    hasPreviousBackup:
                        backupCount > 0,
                    backupCount,
                    message:
                        'Nav izmaiņu'
                });
            }

            // ====================================================
            // TURBO PRICE FOR CHANGED FILES
            // ====================================================

            const turbo =
                getTurbo();

            const fileQuote =
                await quoteTurbo(
                    turbo,
                    totalBytes
                );

            const treasuryBalance =
                await getTreasuryBalance(
                    provider
                );

            const hasEnoughTreasury =
                treasuryBalance >=
                fileQuote.wei;

            console.log(
                'Turbo failu cena:',
                fileQuote.eth,
                'ETH'
            );

            console.log(
                'Turbo failu cena:',
                fileQuote.winc.toString(),
                'winc'
            );

            console.log(
                'Mainīto failu bytes:',
                totalBytes
            );

            console.log(
                'Treasury balance:',
                ethers.formatEther(
                    treasuryBalance
                ),
                'ETH'
            );

            return res.json({
                success: true,
                repoName,
                tokenId:
                    tokenId.toString(),

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

                previousHistory,
                previousManifestId,
                previousBackupNumber,

                fileCount:
                    changedFiles.length,

                totalBytes,

                costWinc:
                    fileQuote.winc.toString(),

                costEth:
                    fileQuote.eth,

                treasuryBalance:
                    treasuryBalance.toString(),

                hasEnoughTreasury,

                hasPreviousBackup:
                    backupCount > 0,

                backupCount
            });
        } catch (error) {
            console.error(
                'BACKUP PREPARE ERROR',
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        errorMessage(error)
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
                costEth,
                walletAddress,
                previousHistory,
                previousManifestId,
                previousBackupNumber
            } = req.body;

            if (!repoName) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav repoName'
                    });
            }

            if (!walletAddress) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav walletAddress'
                    });
            }

            if (!Array.isArray(files)) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'files nav masīvs'
                    });
            }

            if (!tokenId) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Nav tokenId'
                    });
            }

            /*
             * costEth tiek izmantots tikai kā informācija
             * no /prepare-backup.
             *
             * Drošības dēļ mēs NEUZTICAMIES klienta
             * nosūtītajai cenai.
             *
             * Īstā Turbo cena tiek pārrēķināta šeit
             * vēlreiz no failu faktiskajiem byte.
             */

            const provider =
                getProvider();

            // ====================================================
            // VERIFY NFT
            // ====================================================

            const nftContract =
                new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

            const repoHash =
                getRepositoryHash(
                    repoName
                );

            const onChainTokenId =
                await nftContract.repositoryTokens(
                    repoHash
                );

            if (
                onChainTokenId === 0n
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Repo NFT vairs nepastāv'
                    });
            }

            if (
                onChainTokenId.toString() !==
                String(tokenId)
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Token ID neatbilst on-chain token ID'
                    });
            }

            const nftOwner =
                await nftContract.ownerOf(
                    onChainTokenId
                );

            if (
                nftOwner.toLowerCase() !==
                walletAddress.toLowerCase()
            ) {
                return res
                    .status(403)
                    .json({
                        success: false,
                        error:
                            'NFT nepieder wallet adresei'
                    });
            }

            // ====================================================
            // VERIFY SUBSCRIPTION
            // ====================================================

            const subscriptionContract =
                new ethers.Contract(
                    SUBSCRIPTION_ADDRESS,
                    SUBSCRIPTION_ABI,
                    provider
                );

            const subscribed =
                await subscriptionContract.isSubscribed(
                    onChainTokenId
                );

            if (!subscribed) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Abonements vairs nav aktīvs'
                    });
            }

            // ====================================================
            // VERIFY REGISTRY
            // ====================================================

            const registryContract =
                new ethers.Contract(
                    REGISTRY_ADDRESS,
                    REGISTRY_ABI,
                    provider
                );

            const repoId =
                await registryContract.getRepositoryByNFT(
                    onChainTokenId
                );

            if (
                repoId ===
                ethers.ZeroHash
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Repo nav reģistrēts Registry'
                    });
            }

            // ====================================================
            // ZERO FILES
            // ====================================================

            if (files.length === 0) {
                return res.json({
                    success: true,
                    message:
                        'Nav jaunu failu augšupielādei',
                    manifestTxId:
                        null,
                    uploadedFiles: [],
                    costEth:
                        '0',
                    paymentTx:
                        null
                });
            }

            // ====================================================
            // RECALCULATE REAL FILE BYTES
            // ====================================================

            let totalBytes = 0;

            for (
                const file of files
            ) {
                if (
                    !file ||
                    !file.path ||
                    !file.content
                ) {
                    throw new Error(
                        `Nederīgs fails: ${
                            file?.path || 'unknown'
                        }`
                    );
                }

                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                totalBytes +=
                    fileBuffer.length;
            }

            if (totalBytes <= 0) {
                return res.json({
                    success: true,
                    message:
                        'Failu izmērs ir 0 bytes',
                    manifestTxId:
                        null,
                    uploadedFiles: [],
                    costEth:
                        '0',
                    paymentTx:
                        null
                });
            }

            // ====================================================
            // TURBO CLIENT
            // ====================================================

            const turbo =
                getTurbo();

            // ====================================================
            // REAL TURBO QUOTE FOR FILES
            // ====================================================

            const fileQuote =
                await quoteTurbo(
                    turbo,
                    totalBytes
                );

            console.log(
                '----------------------------------------'
            );

            console.log(
                'Turbo failu cena:',
                fileQuote.eth,
                'ETH'
            );

            console.log(
                'Turbo failu cena:',
                fileQuote.winc.toString(),
                'winc'
            );

            console.log(
                'Failu bytes:',
                totalBytes
            );

            console.log(
                'Client costEth:',
                costEth
            );

            console.log(
                '----------------------------------------'
            );

            // ====================================================
            // 1. PAY TURBO FOR FILES
            // ====================================================

            const filePaymentId =
                ethers.id(
                    [
                        'PermRepo',
                        repoName,
                        onChainTokenId.toString(),
                        'files',
                        Date.now().toString()
                    ].join(':')
                );

            const filePayment =
                await payTurboFromTreasury(
                    provider,
                    fileQuote.wei,
                    filePaymentId
                );

            // ====================================================
            // WAIT FOR TURBO PAYMENT
            // ====================================================

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );

            // ====================================================
            // 2. UPLOAD FILES
            // ====================================================

            const uploadResults = [];

            for (
                const file of files
            ) {
                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                console.log(
                    'Augšupielādē:',
                    file.path
                );

                const calculatedHash =
                    crypto
                        .createHash(
                            'sha256'
                        )
                        .update(
                            fileBuffer
                        )
                        .digest('hex');

                /*
                 * Klienta nosūtītais hash tiek izmantots
                 * tikai tad, ja tas sakrīt ar faktisko
                 * faila saturu.
                 */
                const hash =
                    file.hash &&
                    file.hash ===
                        calculatedHash
                        ? file.hash
                        : calculatedHash;

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
                                        file.path
                                },
                                {
                                    name:
                                        'Content-Type',
                                    value:
                                        getContentType(
                                            file.path
                                        )
                                },
                                {
                                    name:
                                        'Content-SHA256',
                                    value:
                                        hash
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
                        `Turbo neatgrieza ID failam: ${file.path}`
                    );
                }

                uploadResults.push({
                    path:
                        file.path,
                    txId:
                        result.id,
                    size:
                        fileBuffer.length,
                    hash
                });
            }

            console.log(
                'Visi mainītie faili augšupielādēti:',
                uploadResults.length
            );

            // ====================================================
            // 3. HISTORY
            // ====================================================

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
                        history.length + 1,

                    manifestId:
                        previousManifestId,

                    url:
                        `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
                });
            }

            // ====================================================
            // 4. CREATE MANIFEST
            // ====================================================

            const backupCount =
                Number(
                    await nftContract.getBackupCount(
                        onChainTokenId
                    )
                );

            const newBackupNumber =
                backupCount + 1;

            const manifest = {
                metadata: {
                    repo:
                        repoName,

                    backupNumber:
                        newBackupNumber,

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

            // ====================================================
            // NEW FILES
            // ====================================================

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
                        `${ARWEAVE_GATEWAY}/raw/${file.txId}`
                };
            }

            // ====================================================
            // UNCHANGED FILES
            // ====================================================

            for (
                const [
                    filePath,
                    info
                ] of Object.entries(
                    unchangedFiles || {}
                )
            ) {
                if (
                    info &&
                    info.txId
                ) {
                    manifest.paths[
                        filePath
                    ] = {
                        id:
                            info.txId,

                        hash:
                            info.hash,

                        url:
                            `${ARWEAVE_GATEWAY}/raw/${info.txId}`
                    };
                }
            }

            // ====================================================
            // MANIFEST INDEX
            // ====================================================

            const manifestPaths =
                Object.keys(
                    manifest.paths
                );

            if (
                manifestPaths.length > 0
            ) {
                manifest.index = {
                    path:
                        manifest.paths[
                            'README.md'
                        ]
                            ? 'README.md'
                            : manifestPaths[0]
                };
            }

            // ====================================================
            // SERIALIZE MANIFEST
            // ====================================================

            const manifestBuffer =
                Buffer.from(
                    JSON.stringify(
                        manifest
                    ),
                    'utf8'
                );

            const manifestBytes =
                manifestBuffer.length;

            console.log(
                'Manifesta izmērs:',
                manifestBytes,
                'bytes'
            );

            // ====================================================
            // 5. REAL TURBO PRICE FOR MANIFEST
            // ====================================================

            const manifestQuote =
                await quoteTurbo(
                    turbo,
                    manifestBytes
                );

            console.log(
                'Turbo manifesta cena:',
                manifestQuote.eth,
                'ETH'
            );

            console.log(
                'Turbo manifesta cena:',
                manifestQuote.winc.toString(),
                'winc'
            );

            // ====================================================
            // 6. PAY TURBO FOR MANIFEST
            // ====================================================

            const manifestPaymentId =
                ethers.id(
                    [
                        'PermRepo',
                        repoName,
                        onChainTokenId.toString(),
                        'manifest',
                        newBackupNumber.toString(),
                        Date.now().toString()
                    ].join(':')
                );

            const manifestPayment =
                await payTurboFromTreasury(
                    provider,
                    manifestQuote.wei,
                    manifestPaymentId
                );

            // ====================================================
            // WAIT FOR MANIFEST PAYMENT
            // ====================================================

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );

            // ====================================================
            // 7. UPLOAD MANIFEST
            // ====================================================

            console.log(
                'Augšupielādē manifestu...'
            );

            const manifestResult =
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
                !manifestResult ||
                !manifestResult.id
            ) {
                throw new Error(
                    'Turbo neatgrieza manifest ID'
                );
            }

            // ====================================================
            // FINAL PRICE
            // ====================================================

            const totalWinc =
                fileQuote.winc +
                manifestQuote.winc;

            const totalWei =
                fileQuote.wei +
                manifestQuote.wei;

            const totalEth =
                ethers.formatEther(
                    totalWei
                );

            console.log(
                '========================================'
            );

            console.log(
                'BACKUP VEIKSMĪGS'
            );

            console.log(
                'Faili:',
                uploadResults.length
            );

            console.log(
                'Failu bytes:',
                totalBytes
            );

            console.log(
                'Manifesta bytes:',
                manifestBytes
            );

            console.log(
                'Kopā winc:',
                totalWinc.toString()
            );

            console.log(
                'Kopā ETH:',
                totalEth
            );

            console.log(
                'Failu payment:',
                filePayment.hash
            );

            console.log(
                'Manifesta payment:',
                manifestPayment.hash
            );

            console.log(
                'Manifest:',
                manifestResult.id
            );

            console.log(
                '========================================'
            );

            return res.json({
                success: true,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                costEth:
                    totalEth,

                costWinc:
                    totalWinc.toString(),

                fileCostEth:
                    fileQuote.eth,

                manifestCostEth:
                    manifestQuote.eth,

                fileCostWinc:
                    fileQuote.winc.toString(),

                manifestCostWinc:
                    manifestQuote.winc.toString(),

                fileBytes:
                    totalBytes,

                manifestBytes,

                paymentTx:
                    filePayment.hash,

                manifestPaymentTx:
                    manifestPayment.hash,

                history
            });
        } catch (error) {
            console.error(
                'BACKUP EXECUTE ERROR',
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        errorMessage(error)
                });
        }
    }
);

// ============================================================
// CONTENT TYPE
// ============================================================

function getContentType(filePath) {
    const lower =
        filePath.toLowerCase();

    if (
        lower.endsWith('.json')
    ) {
        return 'application/json';
    }

    if (
        lower.endsWith('.html')
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
        lower.endsWith('.mjs')
    ) {
        return 'application/javascript';
    }

    if (
        lower.endsWith('.ts')
    ) {
        return 'text/plain';
    }

    if (
        lower.endsWith('.md')
    ) {
        return 'text/markdown';
    }

    if (
        lower.endsWith('.xml')
    ) {
        return 'application/xml';
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
        lower.endsWith('.jpeg')
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
        lower.endsWith('.pdf')
    ) {
        return 'application/pdf';
    }

    return 'application/octet-stream';
}

// ============================================================
// GET GITHUB REPOSITORY FILES
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
            ? `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`
            : `https://api.github.com/repos/${owner}/${repo}/contents`;

    const response =
        await fetch(
            url,
            {
                headers: {
                    Authorization:
                        `Bearer ${githubToken}`,

                    Accept:
                        'application/vnd.github.v3+json',

                    'X-GitHub-Api-Version':
                        '2022-11-28'
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `GitHub API kļūda: ${response.status}`
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

            /*
             * Maksimālais viena faila izmērs:
             * 100 MB.
             */
            if (
                size >
                104857600
            ) {
                console.warn(
                    'Fails pārāk liels, izlaiž:',
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
                                `Bearer ${githubToken}`,

                            Accept:
                                'application/octet-stream'
                        }
                    }
                );

            if (
                !fileResponse.ok
            ) {
                console.warn(
                    'Neizdevās lejupielādēt:',
                    item.path
                );

                continue;
            }

            const fileBuffer =
                Buffer.from(
                    await fileResponse.arrayBuffer()
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
        } else if (
            item.type === 'dir'
        ) {
            const subFiles =
                await getRepoFiles(
                    githubToken,
                    owner,
                    repo,
                    item.path
                );

            files.push(
                ...subFiles
            );
        }
    }

    return files;
}

// ============================================================
// HEALTH
// ============================================================

app.get(
    '/api/health',
    async (req, res) => {
        let treasuryBalance = null;

        try {
            if (
                RPC_URL &&
                TREASURY_ADDRESS
            ) {
                const provider =
                    getProvider();

                treasuryBalance =
                    (
                        await getTreasuryBalance(
                            provider
                        )
                    ).toString();
            }
        } catch (error) {
            treasuryBalance =
                null;
        }

        res.json({
            status: 'ok',

            configured: {
                rpc:
                    !!RPC_URL,

                operatorKey:
                    !!OPERATOR_PRIVATE_KEY,

                treasury:
                    !!TREASURY_ADDRESS,

                nft:
                    !!NFT_ADDRESS,

                subscription:
                    !!SUBSCRIPTION_ADDRESS,

                registry:
                    !!REGISTRY_ADDRESS,

                githubOAuth:
                    !!(
                        GITHUB_CLIENT_ID &&
                        GITHUB_CLIENT_SECRET &&
                        GITHUB_REDIRECT_URI
                    ),

                turbo:
                    !!OPERATOR_PRIVATE_KEY
            },

            treasuryBalance,

            turboToken:
                TURBO_TOKEN
        });
    }
);

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.get(
    '*',
    (req, res) => {
        res.sendFile(
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
            'PermRepo serveris klausās uz porta',
            PORT
        );

        console.log(
            '========================================'
        );

        console.log(
            'RPC_URL:',
            RPC_URL
                ? 'IR'
                : 'NAV'
        );

        console.log(
            'OPERATOR_PRIVATE_KEY:',
            OPERATOR_PRIVATE_KEY
                ? 'IR'
                : 'NAV'
        );

        console.log(
            'TREASURY_ADDRESS:',
            TREASURY_ADDRESS ||
                'NAV'
        );

        console.log(
            'NFT_ADDRESS:',
            NFT_ADDRESS ||
                'NAV'
        );

        console.log(
            'SUBSCRIPTION_ADDRESS:',
            SUBSCRIPTION_ADDRESS ||
                'NAV'
        );

        console.log(
            'REGISTRY_ADDRESS:',
            REGISTRY_ADDRESS ||
                'NAV'
        );

        console.log(
            'TURBO_TOKEN:',
            TURBO_TOKEN
        );

        console.log(
            'TURBO_UPLOAD_URL:',
            TURBO_UPLOAD_URL
        );

        console.log(
            'TURBO_PAYMENT_URL:',
            TURBO_PAYMENT_URL
        );

        console.log(
            '========================================'
        );
    }
);
```

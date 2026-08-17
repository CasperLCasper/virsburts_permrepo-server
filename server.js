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

// ============================================================
// TURBO
// ============================================================
//
// IMPORTANT:
//
// base-eth = ETH on Base / Base Sepolia.
//
// The Turbo SDK is the source of truth for the current upload
// price. We do NOT hardcode a Turbo payment address or price
// here.
//
// The Treasury contract owns the actual payment destination.
// ============================================================

const TURBO_TOKEN =
    process.env.TURBO_TOKEN || 'base-eth';

const TURBO_GATEWAY_URL =
    process.env.TURBO_GATEWAY_URL ||
    'https://sepolia.base.org';

const TURBO_UPLOAD_URL =
    process.env.TURBO_UPLOAD_URL ||
    'https://upload.services.ar-io.dev';

const TURBO_PAYMENT_URL =
    process.env.TURBO_PAYMENT_URL ||
    'https://payment.services.ar-io.dev';

// ============================================================
// ABIs
// ============================================================

const NFT_ABI = [
    "function repositoryTokens(bytes32 repoHash) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function getBackupCount(uint256 tokenId) external view returns (uint256)",
    "function getManifestURI(uint256 tokenId) external view returns (string)",
    "function getNonce(uint256 tokenId) external view returns (uint256)"
];

const SUBSCRIPTION_ABI = [
    "function isSubscribed(uint256 tokenId) external view returns (bool)"
];

const REGISTRY_ABI = [
    "function getRepositoryByNFT(uint256 nftTokenId) external view returns (bytes32)"
];

const TREASURY_ABI = [
    "function payTurbo(uint256 amount, bytes32 paymentId) external",
    "function balance() external view returns (uint256)"
];

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json({ limit: '100mb' }));

app.use(
    express.urlencoded({
        extended: true
    })
);

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
// This wallet does NOT hold Treasury funds.
//
// It only signs the transaction:
// Treasury.payTurbo(...)
//
// The ETH that pays Turbo comes from the Treasury contract.
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

    return TurboFactory.authenticated({
        signer: new EthereumSigner(
            OPERATOR_PRIVATE_KEY
        ),

        token: TURBO_TOKEN,

        gatewayUrl: TURBO_GATEWAY_URL,

        uploadServiceConfig: {
            url: TURBO_UPLOAD_URL
        },

        paymentServiceConfig: {
            url: TURBO_PAYMENT_URL
        }
    });
}

// ============================================================
// ERROR
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
// TURBO PRICE
// ============================================================
//
// IMPORTANT:
//
// Turbo is the source of truth.
//
// We ask Turbo:
//
// "How much base-ETH is required for this many bytes?"
//
// We do not calculate the price ourselves.
//
// The returned tokenPrice is the current Turbo price for the
// configured token (base-eth).
// ============================================================

async function getTurboPriceForBytes(
    turbo,
    byteCount
) {
    if (!Number.isInteger(byteCount)) {
        throw new Error(
            'byteCount jābūt integer'
        );
    }

    if (byteCount <= 0) {
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
            bytes: [byteCount]
        });

    if (
        !Array.isArray(costs) ||
        costs.length === 0 ||
        costs[0].winc === undefined
    ) {
        throw new Error(
            'Turbo getUploadCosts() neatgrieza derīgu winc cenu'
        );
    }

    const costWinc =
        BigInt(
            String(
                costs[0].winc
            )
        );

    // --------------------------------------------------------
    // Current token price
    // --------------------------------------------------------
    //
    // Because TURBO_TOKEN = base-eth,
    // tokenPrice is the amount of Base ETH required.
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
            `Turbo tokenPrice nav derīgs ETH daudzums: ${costEth}`
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
    if (!TREASURY_ADDRESS) {
        return 0n;
    }

    const treasuryContract =
        new ethers.Contract(
            TREASURY_ADDRESS,
            TREASURY_ABI,
            provider
        );

    return await treasuryContract.balance();
}

// ============================================================
// TREASURY PAYMENT
// ============================================================
//
// This is the ONLY place where the operator spends Treasury
// funds.
//
// The operator EOA pays gas for this transaction.
//
// The ETH amount itself comes from the Treasury contract.
// ============================================================

async function payTurboFromTreasury({
    provider,
    amountWei,
    paymentId
}) {
    if (amountWei <= 0n) {
        throw new Error(
            'Treasury payment amount ir 0'
        );
    }

    if (!TREASURY_ADDRESS) {
        throw new Error(
            'TREASURY_ADDRESS nav konfigurēts'
        );
    }

    const operatorWallet =
        getOperatorWallet(
            provider
        );

    const treasuryWrite =
        new ethers.Contract(
            TREASURY_ADDRESS,
            TREASURY_ABI,
            operatorWallet
        );

    const treasuryBalance =
        await treasuryWrite.balance();

    if (treasuryBalance < amountWei) {
        throw new Error(
            `Treasury nepietiek līdzekļu. Nepieciešams ${ethers.formatEther(amountWei)} ETH, pieejams ${ethers.formatEther(treasuryBalance)} ETH`
        );
    }

    const tx =
        await treasuryWrite.payTurbo(
            amountWei,
            paymentId
        );

    const receipt =
        await tx.wait();

    if (!receipt) {
        throw new Error(
            'Treasury payment transaction receipt nav saņemts'
        );
    }

    return {
        hash: tx.hash,
        amountWei,
        amountEth:
            ethers.formatEther(
                amountWei
            )
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
        if (!GITHUB_CLIENT_ID) {
            return res.status(500).json({
                success: false,
                error:
                    'GitHub OAuth nav konfigurēts'
            });
        }

        if (!GITHUB_REDIRECT_URI) {
            return res.status(500).json({
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
        const { code } =
            req.query;

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
                            'Accept':
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
        req.session.destroy(
            () => {
                res.json({
                    success: true
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
// GITHUB REPOS
// ============================================================

app.get(
    '/api/github/repos',
    async (req, res) => {
        const githubToken =
            req.session.githubToken;

        if (!githubToken) {
            return res.status(401).json({
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
                repos.map(
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

            res.json({
                success: true,
                repos:
                    repoList
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error:
                    errorMessage(error)
            });
        }
    }
);

// ============================================================
// CHECK REPO STATUS
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
            let hasSubscription =
                false;
            let isRegistered =
                false;
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
                } catch (e) {
                    console.warn(
                        'Registry pārbaudes kļūda:',
                        errorMessage(e)
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
            res.status(500).json({
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
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav repo nosaukuma'
                });
            }

            if (!walletAddress) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav wallet adreses'
                });
            }

            if (!githubToken) {
                return res.status(401).json({
                    success: false,
                    error:
                        'Nav GitHub autorizācijas'
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
                return res.status(400).json({
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
                return res.status(403).json({
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

            if (
                !(await subscriptionContract.isSubscribed(
                    tokenId
                ))
            ) {
                return res.status(400).json({
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
                return res.status(400).json({
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

            // ------------------------------------------------
            // Previous backup
            // ------------------------------------------------

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
                            const previousManifest =
                                await manifestResponse.json();

                            if (
                                previousManifest.paths
                            ) {
                                previousPaths =
                                    previousManifest.paths;
                            }

                            if (
                                previousManifest.history
                            ) {
                                previousHistory =
                                    previousManifest.history;
                            }

                            if (
                                previousManifest.metadata &&
                                previousManifest.metadata.backupNumber
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
                    } catch (e) {
                        console.warn(
                            'Neizdevās iegūt iepriekšējo manifestu:',
                            errorMessage(e)
                        );
                    }
                }
            }

            // ------------------------------------------------
            // Get GitHub files
            // ------------------------------------------------

            const repoParts =
                repoName.split('/');

            if (
                repoParts.length !== 2
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'repoName jābūt owner/repository formātā'
                });
            }

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    repoParts[0],
                    repoParts[1]
                );

            if (
                currentFiles.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav failu repo'
                });
            }

            // ------------------------------------------------
            // Detect changes
            // ------------------------------------------------

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
                    (
                        sum,
                        file
                    ) =>
                        sum +
                        Number(
                            file.size || 0
                        ),
                    0
                );

            // ------------------------------------------------
            // No changes
            // ------------------------------------------------

            if (
                totalBytes === 0
            ) {
                return res.json({
                    success: true,
                    repoName,
                    tokenId:
                        tokenId.toString(),
                    files: [],
                    unchangedFiles,
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
                    hasEnoughTreasury: true,
                    hasPreviousBackup:
                        backupCount > 0,
                    backupCount,
                    message:
                        'Nav izmaiņu'
                });
            }

            // ------------------------------------------------
            // Turbo pricing
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

            // ------------------------------------------------
            // Return price calculated by Turbo
            // ------------------------------------------------

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
                'BACKUP PREPARE ERROR',
                error
            );

            return res.status(500).json({
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
                walletAddress,
                previousHistory,
                previousManifestId,
                previousBackupNumber
            } = req.body;

            // ------------------------------------------------
            // Validate request
            // ------------------------------------------------

            if (!repoName) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav repoName'
                });
            }

            if (!walletAddress) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav walletAddress'
                });
            }

            if (!Array.isArray(files)) {
                return res.status(400).json({
                    success: false,
                    error:
                        'files nav masīvs'
                });
            }

            if (!tokenId) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav tokenId'
                });
            }

            // ------------------------------------------------
            // Provider
            // ------------------------------------------------

            const provider =
                getProvider();

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

            // ------------------------------------------------
            // Verify token on-chain
            // ------------------------------------------------

            const onChainTokenId =
                await nftContract.repositoryTokens(
                    repoHash
                );

            if (
                onChainTokenId === 0n
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Repo NFT vairs nepastāv'
                });
            }

            if (
                onChainTokenId.toString() !==
                String(tokenId)
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'tokenId neatbilst on-chain NFT'
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
                return res.status(403).json({
                    success: false,
                    error:
                        'NFT nepieder wallet adresei'
                });
            }

            // ------------------------------------------------
            // Subscription
            // ------------------------------------------------

            const subscriptionContract =
                new ethers.Contract(
                    SUBSCRIPTION_ADDRESS,
                    SUBSCRIPTION_ABI,
                    provider
                );

            if (
                !(await subscriptionContract.isSubscribed(
                    onChainTokenId
                ))
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Abonements vairs nav aktīvs'
                });
            }

            // ------------------------------------------------
            // Registry
            // ------------------------------------------------

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
                return res.status(400).json({
                    success: false,
                    error:
                        'Repo nav reģistrēts Registry'
                });
            }

            // ------------------------------------------------
            // Turbo
            // ------------------------------------------------

            const turbo =
                getTurbo();

            // =================================================
            // 1. RECALCULATE FILE PRICE
            // =================================================
            //
            // NEVER trust costEth from the browser.
            //
            // We calculate it again on the server from the
            // actual files received by this request.
            //
            // This is the authoritative price used for the
            // Treasury payment.
            // =================================================

            let totalBytes = 0;

            for (
                const file of files
            ) {
                if (
                    !file ||
                    typeof file.content !==
                        'string'
                ) {
                    return res.status(400).json({
                        success: false,
                        error:
                            `Nederīgs faila saturs: ${file?.path || 'unknown'}`
                    });
                }

                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                if (
                    fileBuffer.length <= 0
                ) {
                    return res.status(400).json({
                        success: false,
                        error:
                            `Fails ir tukšs: ${file.path}`
                    });
                }

                totalBytes +=
                    fileBuffer.length;
            }

            if (
                totalBytes <= 0
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        'Nav mainītu failu augšupielādei'
                });
            }

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

            // =================================================
            // 2. PAY TREASURY FOR FILES
            // =================================================

            const filePaymentId =
                ethers.id(
                    [
                        'PermRepo',
                        'files',
                        repoName,
                        String(
                            onChainTokenId
                        ),
                        Date.now().toString(),
                        crypto
                            .randomBytes(8)
                            .toString('hex')
                    ].join(':')
                );

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
            // Wait for Turbo payment propagation
            // ------------------------------------------------

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );

            // =================================================
            // 3. UPLOAD FILES
            // =================================================

            const uploadResults = [];

            for (
                const file of files
            ) {
                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

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
                                        file.hash
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

                uploadResults.push({
                    path:
                        file.path,
                    txId:
                        result.id,
                    size:
                        fileBuffer.length,
                    hash:
                        file.hash
                });
            }

            // =================================================
            // 4. HISTORY
            // =================================================

            const history =
                [
                    ...(previousHistory || [])
                ];

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
                        `${ARWEAVE_GATEWAY}/raw/${previousManifestId}`
                });
            }

            // =================================================
            // 5. BUILD MANIFEST
            // =================================================

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

            // ------------------------------------------------
            // New files
            // ------------------------------------------------

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

            // ------------------------------------------------
            // Unchanged files
            // ------------------------------------------------

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

            // ------------------------------------------------
            // Manifest index
            // ------------------------------------------------

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

            // =================================================
            // 6. SERIALIZE MANIFEST
            // =================================================

            const manifestBuffer =
                Buffer.from(
                    JSON.stringify(
                        manifest
                    ),
                    'utf8'
                );

            const manifestBytes =
                manifestBuffer.length;

            // =================================================
            // 7. CALCULATE MANIFEST PRICE
            // =================================================
            //
            // This is done AFTER the file uploads because the
            // manifest contains the actual Turbo transaction IDs.
            //
            // Therefore we now know its exact byte size.
            // =================================================

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

            // =================================================
            // 8. PAY TREASURY FOR MANIFEST
            // =================================================

            const manifestPaymentId =
                ethers.id(
                    [
                        'PermRepo',
                        'manifest',
                        repoName,
                        String(
                            onChainTokenId
                        ),
                        Date.now().toString(),
                        crypto
                            .randomBytes(8)
                            .toString('hex')
                    ].join(':')
                );

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
            // Wait for Turbo payment propagation
            // ------------------------------------------------

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        5000
                    )
            );

            // =================================================
            // 9. UPLOAD MANIFEST
            // =================================================

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

            // =================================================
            // 10. FINAL RESPONSE
            // =================================================

            const totalPaymentWei =
                filePrice.costWei +
                manifestPrice.costWei;

            const totalPaymentEth =
                ethers.formatEther(
                    totalPaymentWei
                );

            return res.json({
                success: true,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                costEth:
                    totalPaymentEth,

                costWei:
                    totalPaymentWei.toString(),

                costWinc:
                    (
                        filePrice.costWinc +
                        manifestPrice.costWinc
                    ).toString(),

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

                history
            });

        } catch (error) {
            console.error(
                'BACKUP EXECUTE ERROR',
                error
            );

            return res.status(500).json({
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

function getContentType(
    filePath
) {
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
// GET REPOSITORY FILES
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
        !Array.isArray(
            contents
        )
    ) {
        return files;
    }

    for (
        const item of contents
    ) {
        if (
            item.type ===
            'file'
        ) {
            const size =
                Number(
                    item.size || 0
                );

            if (
                size >
                104857600
            ) {
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
            item.type ===
            'dir'
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
    (req, res) => {
        res.json({
            status:
                'ok',

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
    }
);
```

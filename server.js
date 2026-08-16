import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
*/

const RPC_URL = process.env.RPC_URL;

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

/*
|--------------------------------------------------------------------------
| TURBO CONFIG
|--------------------------------------------------------------------------
*/

const TURBO_TOKEN =
    process.env.TURBO_TOKEN ||
    'base-eth';

const TURBO_UPLOAD_URL =
    process.env.TURBO_UPLOAD_URL ||
    'https://upload.services.ar-io.dev';

const TURBO_PAYMENT_URL =
    process.env.TURBO_PAYMENT_URL ||
    'https://payment.services.ar-io.dev';

/*
|--------------------------------------------------------------------------
| ABIs
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.use(
    express.json({
        limit: '100mb'
    })
);

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

/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
*/

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie: {
            secure: false,
            maxAge: 3600000
        }
    })
);

/*
|--------------------------------------------------------------------------
| CONFIG API
|--------------------------------------------------------------------------
*/

app.get('/api/config', (req, res) => {
    res.json({
        chainId: CHAIN_ID,
        treasuryAddress: TREASURY_ADDRESS,
        nftAddress: NFT_ADDRESS,
        subscriptionAddress: SUBSCRIPTION_ADDRESS,
        registryAddress: REGISTRY_ADDRESS,
        rpcUrl: RPC_URL,
        arweaveGateway: ARWEAVE_GATEWAY
    });
});

/*
|--------------------------------------------------------------------------
| GITHUB LOGIN
|--------------------------------------------------------------------------
*/

app.get('/api/github/login', (req, res) => {
    if (!GITHUB_CLIENT_ID) {
        return res.status(500).json({
            error: 'GitHub OAuth nav konfigurēts'
        });
    }

    const scope = 'repo read:org';

    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        scope,
        redirect_uri: GITHUB_REDIRECT_URI
    });

    const url =
        `https://github.com/login/oauth/authorize?${params.toString()}`;

    res.redirect(url);
});

/*
|--------------------------------------------------------------------------
| GITHUB CALLBACK
|--------------------------------------------------------------------------
*/

app.get('/api/github/callback', async (req, res) => {
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
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        client_id: GITHUB_CLIENT_ID,
                        client_secret: GITHUB_CLIENT_SECRET,
                        code,
                        redirect_uri: GITHUB_REDIRECT_URI
                    })
                }
            );

        const tokenData =
            await tokenResponse.json();

        if (!tokenData.access_token) {
            console.error(
                'GitHub token kļūda:',
                tokenData
            );

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
});

/*
|--------------------------------------------------------------------------
| GITHUB LOGOUT
|--------------------------------------------------------------------------
*/

app.get('/api/github/logout', (req, res) => {

    req.session.destroy(
        () => {
            res.json({
                success: true
            });
        }
    );
});

/*
|--------------------------------------------------------------------------
| GITHUB USER
|--------------------------------------------------------------------------
*/

app.get('/api/github/user', (req, res) => {

    if (req.session.githubUser) {

        return res.json({
            success: true,
            user: req.session.githubUser,
            avatar: req.session.githubAvatar || null
        });
    }

    res.json({
        success: false
    });
});

/*
|--------------------------------------------------------------------------
| GITHUB REPOSITORIES
|--------------------------------------------------------------------------
*/

app.get('/api/github/repos', async (req, res) => {

    const githubToken =
        req.session.githubToken;

    if (!githubToken) {
        return res.status(401).json({
            success: false,
            error: 'Nav autorizēts caur GitHub'
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
                name: repo.full_name,
                description: repo.description,
                private: repo.private,
                language: repo.language,
                updatedAt: repo.updated_at
            }));

        res.json({
            success: true,
            repos: repoList
        });

    } catch (error) {

        console.error(
            'Repo saraksta kļūda:',
            error
        );

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| CHECK REPOSITORY STATUS
|--------------------------------------------------------------------------
*/

app.post(
    '/api/check-repo-status',
    async (req, res) => {

        try {

            const {
                repoName,
                walletAddress
            } = req.body;

            if (!repoName) {
                return res.status(400).json({
                    success: false,
                    error: 'Nav repo'
                });
            }

            if (!walletAddress) {
                return res.status(400).json({
                    success: false,
                    error: 'Nav wallet'
                });
            }

            if (!RPC_URL) {
                return res.status(500).json({
                    success: false,
                    error: 'RPC_URL nav konfigurēts'
                });
            }

            if (!NFT_ADDRESS) {
                return res.status(500).json({
                    success: false,
                    error: 'NFT_ADDRESS nav konfigurēts'
                });
            }

            const provider =
                new ethers.JsonRpcProvider(
                    RPC_URL
                );

            const repoHash =
                ethers.keccak256(
                    ethers.AbiCoder
                        .defaultAbiCoder()
                        .encode(
                            ['string'],
                            [repoName]
                        )
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

                if (SUBSCRIPTION_ADDRESS) {

                    const subscriptionContract =
                        new ethers.Contract(
                            SUBSCRIPTION_ADDRESS,
                            SUBSCRIPTION_ABI,
                            provider
                        );

                    hasSubscription =
                        await subscriptionContract
                            .isSubscribed(
                                tokenId
                            );
                }

                backupCount =
                    Number(
                        await nftContract
                            .getBackupCount(
                                tokenId
                            )
                    );

                lastManifestURI =
                    await nftContract
                        .getManifestURI(
                            tokenId
                        );

                if (REGISTRY_ADDRESS) {

                    const registryContract =
                        new ethers.Contract(
                            REGISTRY_ADDRESS,
                            REGISTRY_ABI,
                            provider
                        );

                    try {

                        const repoId =
                            await registryContract
                                .getRepositoryByNFT(
                                    tokenId
                                );

                        isRegistered =
                            repoId !==
                            ethers.ZeroHash;

                    } catch (error) {

                        console.warn(
                            'Registry pārbaudes kļūda:',
                            error.message
                        );

                        isRegistered = false;
                    }
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

            console.error(
                'Repo statusa kļūda:',
                error
            );

            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| PREPARE BACKUP
|--------------------------------------------------------------------------
|
| ŠIS ENDPOINTS:
|
| 1. pārbauda NFT;
| 2. pārbauda owner;
| 3. pārbauda subscription;
| 4. pārbauda registry;
| 5. nolasa iepriekšējo manifestu;
| 6. nolasa GitHub repo;
| 7. nosaka izmainītos failus;
| 8. aprēķina Turbo cenu.
|
| ŠEIT NAV MAKSĀJUMA.
|
|--------------------------------------------------------------------------
*/

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

            /*
             * ------------------------------------------------------
             * VALIDĀCIJA
             * ------------------------------------------------------
             */

            if (!repoName) {
                return res.status(400).json({
                    success: false,
                    error: 'Nav repo nosaukuma'
                });
            }

            if (!walletAddress) {
                return res.status(400).json({
                    success: false,
                    error: 'Nav wallet adreses'
                });
            }

            if (!githubToken) {
                return res.status(401).json({
                    success: false,
                    error: 'Nav GitHub autorizācijas'
                });
            }

            if (!RPC_URL) {
                return res.status(500).json({
                    success: false,
                    error: 'RPC_URL nav konfigurēts'
                });
            }

            if (!NFT_ADDRESS) {
                return res.status(500).json({
                    success: false,
                    error: 'NFT_ADDRESS nav konfigurēts'
                });
            }

            if (!SUBSCRIPTION_ADDRESS) {
                return res.status(500).json({
                    success: false,
                    error:
                        'SUBSCRIPTION_ADDRESS nav konfigurēts'
                });
            }

            if (!REGISTRY_ADDRESS) {
                return res.status(500).json({
                    success: false,
                    error:
                        'REGISTRY_ADDRESS nav konfigurēts'
                });
            }

            /*
             * ------------------------------------------------------
             * PROVIDER
             * ------------------------------------------------------
             */

            const provider =
                new ethers.JsonRpcProvider(
                    RPC_URL
                );

            /*
             * ------------------------------------------------------
             * REPO HASH
             * ------------------------------------------------------
             */

            const repoHash =
                ethers.keccak256(
                    ethers.AbiCoder
                        .defaultAbiCoder()
                        .encode(
                            ['string'],
                            [repoName]
                        )
                );

            /*
             * ------------------------------------------------------
             * NFT
             * ------------------------------------------------------
             */

            const nftContract =
                new ethers.Contract(
                    NFT_ADDRESS,
                    NFT_ABI,
                    provider
                );

            const tokenId =
                await nftContract
                    .repositoryTokens(
                        repoHash
                    );

            if (tokenId === 0n) {

                return res.status(400).json({
                    success: false,
                    error: 'Nav NFT šim repo'
                });
            }

            /*
             * ------------------------------------------------------
             * OWNER
             * ------------------------------------------------------
             */

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

            /*
             * ------------------------------------------------------
             * SUBSCRIPTION
             * ------------------------------------------------------
             */

            const subscriptionContract =
                new ethers.Contract(
                    SUBSCRIPTION_ADDRESS,
                    SUBSCRIPTION_ABI,
                    provider
                );

            const isSubscribed =
                await subscriptionContract
                    .isSubscribed(
                        tokenId
                    );

            if (!isSubscribed) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Nav aktīva abonementa'
                });
            }

            /*
             * ------------------------------------------------------
             * REGISTRY
             * ------------------------------------------------------
             */

            const registryContract =
                new ethers.Contract(
                    REGISTRY_ADDRESS,
                    REGISTRY_ABI,
                    provider
                );

            const repoId =
                await registryContract
                    .getRepositoryByNFT(
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

            /*
             * ------------------------------------------------------
             * BACKUP COUNT
             * ------------------------------------------------------
             */

            const backupCount =
                Number(
                    await nftContract
                        .getBackupCount(
                            tokenId
                        )
                );

            /*
             * ------------------------------------------------------
             * IEPRIEKŠĒJAIS MANIFESTS
             * ------------------------------------------------------
             */

            let previousManifest = null;

            if (backupCount > 0) {

                const manifestURI =
                    await nftContract
                        .getManifestURI(
                            tokenId
                        );

                if (
                    manifestURI &&
                    manifestURI.startsWith(
                        'ar://'
                    )
                ) {

                    const txId =
                        manifestURI.substring(
                            5
                        );

                    try {

                        const manifestResponse =
                            await fetch(
                                `${ARWEAVE_GATEWAY}/${txId}`
                            );

                        if (
                            manifestResponse.ok
                        ) {

                            previousManifest =
                                await manifestResponse
                                    .json();
                        } else {

                            console.warn(
                                'Manifest gateway atgrieza:',
                                manifestResponse.status
                            );
                        }

                    } catch (error) {

                        console.warn(
                            'Neizdevās iegūt iepriekšējo manifestu:',
                            error.message
                        );
                    }
                }
            }

            /*
             * ------------------------------------------------------
             * GITHUB REPO
             * ------------------------------------------------------
             */

            const repoParts =
                repoName.split('/');

            if (
                repoParts.length !== 2
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Repo jābūt formātā owner/repository'
                });
            }

            const owner =
                repoParts[0];

            const repo =
                repoParts[1];

            /*
             * ------------------------------------------------------
             * IEGŪSTAM VISUS FAILUS
             * ------------------------------------------------------
             */

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    owner,
                    repo
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

            /*
             * ------------------------------------------------------
             * SALĪDZINĀM AR IEPRIEKŠĒJO MANIFESTU
             * ------------------------------------------------------
             */

            const previousPaths =
                previousManifest &&
                previousManifest.paths
                    ? previousManifest.paths
                    : {};

            const changedFiles = [];

            const unchangedFiles = {};

            for (
                const file
                of currentFiles
            ) {

                const previousFile =
                    previousPaths[
                        file.path
                    ];

                if (
                    previousFile &&
                    previousFile.id
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

            /*
             * ------------------------------------------------------
             * TOTAL BYTES
             * ------------------------------------------------------
             */

            const totalBytes =
                changedFiles.reduce(
                    (
                        sum,
                        file
                    ) => {

                        return (
                            sum +
                            Number(
                                file.size || 0
                            )
                        );

                    },
                    0
                );

            /*
             * ------------------------------------------------------
             * NAV IZMAIŅU
             * ------------------------------------------------------
             */

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
                    costEth: '0',
                    hasPreviousBackup:
                        backupCount > 0,
                    backupCount,
                    message:
                        'Nav izmaiņu'
                });
            }

            /*
             * ------------------------------------------------------
             * TURBO
             * ------------------------------------------------------
             */

            if (!OPERATOR_PRIVATE_KEY) {

                return res.status(500).json({
                    success: false,
                    error:
                        'OPERATOR_PRIVATE_KEY nav konfigurēts'
                });
            }

            const turbo =
                TurboFactory.authenticated({
                    privateKey:
                        OPERATOR_PRIVATE_KEY,

                    token:
                        TURBO_TOKEN,

                    uploadServiceConfig: {
                        url:
                            TURBO_UPLOAD_URL
                    },

                    paymentServiceConfig: {
                        url:
                            TURBO_PAYMENT_URL
                    }
                });

            /*
             * ------------------------------------------------------
             * TURBO CENA
             * ------------------------------------------------------
             *
             * SVARĪGI:
             *
             * bytes ir skaitlis.
             *
             * Nevis:
             *
             * { bytes: [totalBytes] }
             *
             * ------------------------------------------------------
             */

            const costs =
                await turbo.getUploadCosts({
                    bytes: totalBytes
                });

            /*
             * ------------------------------------------------------
             * DEBUG
             * ------------------------------------------------------
             */

            console.log(
                'Turbo getUploadCosts result:'
            );

            console.dir(
                costs,
                {
                    depth: null
                }
            );

            /*
             * ------------------------------------------------------
             * PĀRBAUDĀM REZULTĀTU
             * ------------------------------------------------------
             */

            if (
                !costs
            ) {

                throw new Error(
                    'Turbo getUploadCosts atgrieza undefined'
                );
            }

            if (
                !Array.isArray(costs)
            ) {

                throw new Error(
                    'Turbo getUploadCosts neatgrieza masīvu'
                );
            }

            if (
                costs.length === 0
            ) {

                throw new Error(
                    'Turbo getUploadCosts atgrieza tukšu masīvu'
                );
            }

            const costInfo =
                costs[0];

            if (
                !costInfo
            ) {

                throw new Error(
                    'Turbo costInfo ir undefined'
                );
            }

            console.log(
                'Turbo costInfo:'
            );

            console.dir(
                costInfo,
                {
                    depth: null
                }
            );

            /*
             * ------------------------------------------------------
             * TOKEN AMOUNT
             * ------------------------------------------------------
             */

            if (
                costInfo.tokenAmount ===
                undefined ||
                costInfo.tokenAmount ===
                null
            ) {

                throw new Error(
                    'Turbo izmaksu rezultātā nav tokenAmount'
                );
            }

            const tokenAmount =
                BigInt(
                    costInfo
                        .tokenAmount
                        .toString()
                );

            /*
             * ------------------------------------------------------
             * BASE ETH
             *
             * tokenAmount ir wei.
             * ------------------------------------------------------
             */

            const costEth =
                ethers.formatEther(
                    tokenAmount
                );

            /*
             * ------------------------------------------------------
             * RESPONSE
             * ------------------------------------------------------
             */

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

                fileCount:
                    changedFiles.length,

                totalBytes,

                costEth,

                turboCost: {

                    token:
                        TURBO_TOKEN,

                    tokenAmount:
                        tokenAmount.toString(),

                    bytes:
                        totalBytes
                },

                hasPreviousBackup:
                    backupCount > 0,

                backupCount
            });

        } catch (error) {

            console.error(
                '========================================'
            );

            console.error(
                'BACKUP PREPARE ERROR'
            );

            console.error(
                error
            );

            console.error(
                '========================================'
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'Nezināma kļūda'
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| EXECUTE BACKUP
|--------------------------------------------------------------------------
|
| ŠEIT sākas faktiskā naudas kustība.
|
| Lietotājs:
|
|   wallet
|      ↓
|   Treasury
|
| Operators:
|
|   OPERATOR_PRIVATE_KEY
|      ↓
|   Treasury.payTurbo()
|
| Pēc tam Turbo saņem maksājumu no operatora,
| izmantojot operatora EOA.
|
|--------------------------------------------------------------------------
*/

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
                walletAddress
            } = req.body;

            /*
             * ------------------------------------------------------
             * VALIDĀCIJA
             * ------------------------------------------------------
             */

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

            if (!unchangedFiles) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Nav unchangedFiles'
                });
            }

            if (!tokenId) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Nav tokenId'
                });
            }

            if (!costEth) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Nav costEth'
                });
            }

            if (!RPC_URL) {

                return res.status(500).json({
                    success: false,
                    error:
                        'RPC_URL nav konfigurēts'
                });
            }

            if (!OPERATOR_PRIVATE_KEY) {

                return res.status(500).json({
                    success: false,
                    error:
                        'OPERATOR_PRIVATE_KEY nav konfigurēts'
                });
            }

            if (!TREASURY_ADDRESS) {

                return res.status(500).json({
                    success: false,
                    error:
                        'TREASURY_ADDRESS nav konfigurēts'
                });
            }

            /*
             * ------------------------------------------------------
             * PROVIDER
             * ------------------------------------------------------
             */

            const provider =
                new ethers.JsonRpcProvider(
                    RPC_URL
                );

            /*
             * ------------------------------------------------------
             * OPERATOR WALLET
             * ------------------------------------------------------
             */

            const operatorWallet =
                new ethers.Wallet(
                    OPERATOR_PRIVATE_KEY,
                    provider
                );

            /*
             * ------------------------------------------------------
             * TREASURY
             * ------------------------------------------------------
 */

            const treasuryContract =
                new ethers.Contract(
                    TREASURY_ADDRESS,
                    TREASURY_ABI,
                    provider
                );

            /*
             * ------------------------------------------------------
             * COST
             * ------------------------------------------------------
             */

            const costWei =
                ethers.parseEther(
                    String(costEth)
                );

            /*
             * ------------------------------------------------------
             * TREASURY BALANCE
             * ------------------------------------------------------
             */

            const treasuryBalance =
                await treasuryContract.balance();

            console.log(
                'Treasury balance:',
                ethers.formatEther(
                    treasuryBalance
                )
            );

            console.log(
                'Required:',
                ethers.formatEther(
                    costWei
                )
            );

            if (
                treasuryBalance <
                costWei
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Treasury nav pietiekami līdzekļu'
                });
            }

            /*
             * ------------------------------------------------------
             * PAYMENT ID
             * ------------------------------------------------------
             */

            const paymentId =
                ethers.id(
                    [
                        repoName,
                        walletAddress,
                        tokenId,
                        Date.now().toString()
                    ].join(':')
                );

            /*
             * ------------------------------------------------------
             * TREASURY PAY TURBO
             * ------------------------------------------------------
             */

            const treasuryWrite =
                new ethers.Contract(
                    TREASURY_ADDRESS,
                    TREASURY_ABI,
                    operatorWallet
                );

            console.log(
                'Izsauc Treasury.payTurbo()...'
            );

            const payTx =
                await treasuryWrite.payTurbo(
                    costWei,
                    paymentId
                );

            console.log(
                'Treasury tx:',
                payTx.hash
            );

            await payTx.wait();

            console.log(
                'Treasury maksājums apstiprināts.'
            );

            /*
             * ------------------------------------------------------
             * TURBO SIGNER
             * ------------------------------------------------------
             */

            const signer =
                new EthereumSigner(
                    OPERATOR_PRIVATE_KEY
                );

            /*
             * ------------------------------------------------------
             * TURBO CLIENT
             * ------------------------------------------------------
             */

            const turbo =
                TurboFactory.authenticated({

                    signer,

                    token:
                        TURBO_TOKEN,

                    uploadServiceConfig: {
                        url:
                            TURBO_UPLOAD_URL
                    },

                    paymentServiceConfig: {
                        url:
                            TURBO_PAYMENT_URL
                    }
                });

            /*
             * ------------------------------------------------------
             * TURBO BALANCE PIRMS UPLOAD
             * ------------------------------------------------------
             */

            let turboBalanceBefore = null;

            try {

                const balance =
                    await turbo.getBalance();

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceBefore =
                        balance.winc
                            .toString();

                    console.log(
                        'Turbo balance before:',
                        turboBalanceBefore
                    );
                }

            } catch (error) {

                console.warn(
                    'Turbo balance pārbaude neizdevās:',
                    error.message
                );
            }

            /*
             * ------------------------------------------------------
             * SVARĪGI
             * ------------------------------------------------------
             *
             * Treasury.payTurbo() jau ir nosūtījis
             * ETH no Treasury uz Turbo payment adresi.
             *
             * Tāpēc šeit NEIZSAUCAM:
             *
             * turbo.topUpWithTokens(...)
             *
             * ar to pašu summu vēlreiz.
             *
             * Tas radītu otru maksājumu.
             *
             * ------------------------------------------------------
             */

            /*
             * ------------------------------------------------------
             * UPLOAD FAILI
             * ------------------------------------------------------
             */

            const uploadResults = [];

            for (
                const file
                of files
            ) {

                if (
                    !file.content
                ) {

                    throw new Error(
                        `Failam nav content: ${file.path}`
                    );
                }

                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                console.log(
                    'Augšupielādē:',
                    file.path,
                    fileBuffer.length,
                    'bytes'
                );

                const result =
                    await turbo.uploadFile({

                        fileStreamFactory:
                            () => {

                                const stream =
                                    requireReadableStream(
                                        fileBuffer
                                    );

                                return stream;
                            },

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
                                        'text/plain'
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
                        file.size,

                    hash:
                        file.hash
                });
            }

            /*
             * ------------------------------------------------------
             * MANIFEST
             * ------------------------------------------------------
             */

            const manifest = {

                manifest:
                    'arweave/paths',

                version:
                    '0.2.0',

                index: {
                    path:
                        'README.md'
                },

                paths: {},

                metadata: {

                    repo:
                        repoName,

                    timestamp:
                        new Date()
                            .toISOString(),

                    generatedBy:
                        'PermRepo v1.0.0'
                }
            };

            /*
             * ------------------------------------------------------
             * JAUNIE FAILI
             * ------------------------------------------------------
             */

            for (
                const file
                of uploadResults
            ) {

                manifest.paths[
                    file.path
                ] = {
                    id:
                        file.txId
                };
            }

            /*
             * ------------------------------------------------------
             * NEMAINĪTIE FAILI
             * ------------------------------------------------------
             */

            for (
                const [
                    filePath,
                    info
                ]
                of Object.entries(
                    unchangedFiles
                )
            ) {

                manifest.paths[
                    filePath
                ] = {
                    id:
                        info.txId
                };
            }

            /*
             * ------------------------------------------------------
             * INDEX
             * ------------------------------------------------------
             */

            if (
                !manifest.paths[
                    'README.md'
                ]
            ) {

                const manifestPaths =
                    Object.keys(
                        manifest.paths
                    );

                if (
                    manifestPaths.length > 0
                ) {

                    manifest.index.path =
                        manifestPaths[0];

                } else {

                    delete manifest.index;
                }
            }

            /*
             * ------------------------------------------------------
             * MANIFEST UPLOAD
             * ------------------------------------------------------
             */

            const manifestBuffer =
                Buffer.from(
                    JSON.stringify(
                        manifest
                    ),
                    'utf8'
                );

            console.log(
                'Augšupielādē manifestu...'
            );

            const manifestResult =
                await turbo.uploadFile({

                    fileStreamFactory:
                        () =>
                            requireReadableStream(
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

            /*
             * ------------------------------------------------------
             * TURBO BALANCE PĒC UPLOAD
             * ------------------------------------------------------
             */

            let turboBalanceAfter = null;

            try {

                const balance =
                    await turbo.getBalance();

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceAfter =
                        balance.winc
                            .toString();

                    console.log(
                        'Turbo balance after:',
                        turboBalanceAfter
                    );
                }

            } catch (error) {

                console.warn(
                    'Turbo balance pēc upload neizdevās:',
                    error.message
                );
            }

            /*
             * ------------------------------------------------------
             * RESPONSE
             * ------------------------------------------------------
             */

            res.json({

                success:
                    true,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                costEth:
                    String(costEth),

                paymentId,

                treasuryPaymentTx:
                    payTx.hash,

                turboBalanceBefore,

                turboBalanceAfter
            });

        } catch (error) {

            console.error(
                '========================================'
            );

            console.error(
                'BACKUP EXECUTE ERROR'
            );

            console.error(
                error
            );

            console.error(
                '========================================'
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'Nezināma kļūda'
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| BUFFER -> READABLE STREAM
|--------------------------------------------------------------------------
|
| Turbo uploadFile sagaida stream factory.
|
|--------------------------------------------------------------------------
*/

function requireReadableStream(buffer) {

    /*
     * Node.js Readable ir pieejams no node:stream.
     *
     * Lai nebūtu jāizmanto require() ES module režīmā,
     * izmantojam Web ReadableStream.
     */

    return new ReadableStream({

        start(controller) {

            controller.enqueue(
                new Uint8Array(buffer)
            );

            controller.close();
        }
    });
}

/*
|--------------------------------------------------------------------------
| GET GITHUB REPOSITORY FILES
|--------------------------------------------------------------------------
*/

async function getRepoFiles(
    githubToken,
    owner,
    repo,
    repoPath = ''
) {

    const files = [];

    const encodedPath =
        repoPath
            .split('/')
            .map(
                encodeURIComponent
            )
            .join('/');

    const url =
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

    const response =
        await fetch(
            url,
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

    const contents =
        await response.json();

    /*
     * GitHub atgriež masīvu tikai tad,
     * ja ceļš ir directory.
     */

    if (!Array.isArray(contents)) {

        return files;
    }

    for (
        const item
        of contents
    ) {

        /*
         * ------------------------------------------------------
         * FILE
         * ------------------------------------------------------
         */

        if (
            item.type === 'file'
        ) {

            /*
             * 100 MB limits.
             */

            if (
                Number(item.size || 0) >
                104857600
            ) {

                console.warn(
                    'Fails pārsniedz 100 MB un tiek izlaists:',
                    item.path
                );

                continue;
            }

            if (
                !item.download_url
            ) {

                console.warn(
                    'Failam nav download_url:',
                    item.path
                );

                continue;
            }

            const fileResponse =
                await fetch(
                    item.download_url,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${githubToken}`
                        }
                    }
                );

            if (
                !fileResponse.ok
            ) {

                throw new Error(
                    `GitHub faila lejupielādes kļūda: ${item.path} (${fileResponse.status})`
                );
            }

            const fileBuffer =
                Buffer.from(
                    await fileResponse.arrayBuffer()
                );

            files.push({

                path:
                    item.path,

                size:
                    fileBuffer.length,

                content:
                    fileBuffer.toString(
                        'base64'
                    ),

                hash:
                    crypto
                        .createHash(
                            'sha256'
                        )
                        .update(
                            fileBuffer
                        )
                        .digest(
                            'hex'
                        )
            });

        /*
         * ------------------------------------------------------
         * DIRECTORY
         * ------------------------------------------------------
         */

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

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    '/api/health',
    async (req, res) => {

        let operatorAddress = null;

        /*
         * Mēģinām tikai nolasīt operatora adresi.
         * Nekāda transakcija netiek veikta.
         */

        if (
            OPERATOR_PRIVATE_KEY
        ) {

            try {

                const operatorWallet =
                    new ethers.Wallet(
                        OPERATOR_PRIVATE_KEY
                    );

                operatorAddress =
                    operatorWallet.address;

            } catch (error) {

                operatorAddress = null;
            }
        }

        res.json({

            status:
                'ok',

            configured: {

                rpc:
                    !!RPC_URL,

                operatorKey:
                    !!OPERATOR_PRIVATE_KEY,

                operatorAddress,

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

                turboUpload:
                    TURBO_UPLOAD_URL,

                turboPayment:
                    TURBO_PAYMENT_URL
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| FALLBACK
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

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

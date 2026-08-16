import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';
import session from 'express-session';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

/*
|--------------------------------------------------------------------------
| PATHS
|--------------------------------------------------------------------------
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

const app = express();

const PORT =
    process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| TURBO
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| getUploadCosts() -> winc
|
| winc nav Base ETH.
|
| Mēs nekad neizmantojam:
|
| costInfo.tokenAmount
|
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
| OPTIONAL TURBO RESERVE SETTINGS
|--------------------------------------------------------------------------
|
| Ja iestatīts, serveris neļaus backup izpildīt,
| ja operatora Turbo kredītu atlikums pēc backup
| būtu mazāks par šo rezervi.
|
| Piemēram:
|
| TURBO_MIN_RESERVE_WINC=1000000000
|
| Ja nav iestatīts -> 0.
|--------------------------------------------------------------------------
*/

const TURBO_MIN_RESERVE_WINC =
    process.env.TURBO_MIN_RESERVE_WINC
        ? BigInt(process.env.TURBO_MIN_RESERVE_WINC)
        : 0n;

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

/*
|--------------------------------------------------------------------------
| EXPRESS MIDDLEWARE
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
        path.join(
            __dirname,
            'public'
        )
    )
);

/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
*/

app.use(
    session({
        secret:
            SESSION_SECRET,

        resave:
            false,

        saveUninitialized:
            true,

        cookie: {
            secure:
                false,

            httpOnly:
                true,

            maxAge:
                3600000
        }
    })
);

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Izveido EVM provider.
 */
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

/**
 * Izveido operatora wallet.
 *
 * Šis wallet tiek izmantots tikai:
 *
 * - Turbo data-item signing;
 * - Turbo credit balance lasīšanai.
 *
 * Šeit netiek saņemti lietotāja līdzekļi.
 */
function getOperatorWallet(
    provider
) {

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

/**
 * Izveido autentificētu Turbo klientu.
 */
function getTurbo() {

    if (!OPERATOR_PRIVATE_KEY) {
        throw new Error(
            'OPERATOR_PRIVATE_KEY nav konfigurēts'
        );
    }

    return TurboFactory.authenticated({

        signer:
            new EthereumSigner(
                OPERATOR_PRIVATE_KEY
            ),

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
}

/**
 * Buffer -> Web ReadableStream.
 *
 * Turbo SDK atbalsta Buffer/ReadableStream,
 * bet mēs izmantojam Web ReadableStream,
 * lai nebūtu require() ES module režīmā.
 */
function bufferToReadableStream(
    buffer
) {

    return new ReadableStream({

        start(controller) {

            controller.enqueue(
                new Uint8Array(
                    buffer
                )
            );

            controller.close();
        }
    });
}

/**
 * Normalizē kļūdu.
 */
function errorMessage(
    error
) {

    if (
        error &&
        typeof error.message === 'string'
    ) {
        return error.message;
    }

    return String(
        error
    );
}

/**
 * Aprēķina repo hash tāpat kā smart contract.
 */
function getRepositoryHash(
    repoName
) {

    return ethers.keccak256(
        ethers.AbiCoder
            .defaultAbiCoder()
            .encode(
                ['string'],
                [repoName]
            )
    );
}

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| GITHUB LOGIN
|--------------------------------------------------------------------------
*/

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

        const url =
            `https://github.com/login/oauth/authorize?${params.toString()}`;

        res.redirect(
            url
        );
    }
);

/*
|--------------------------------------------------------------------------
| GITHUB CALLBACK
|--------------------------------------------------------------------------
*/

app.get(
    '/api/github/callback',
    async (req, res) => {

        const {
            code
        } = req.query;

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
                        method:
                            'POST',

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

            if (
                !tokenResponse.ok
            ) {

                throw new Error(
                    `GitHub OAuth token HTTP ${tokenResponse.status}`
                );
            }

            const tokenData =
                await tokenResponse.json();

            if (
                !tokenData.access_token
            ) {

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

            if (
                !userResponse.ok
            ) {

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

/*
|--------------------------------------------------------------------------
| GITHUB LOGOUT
|--------------------------------------------------------------------------
*/

app.get(
    '/api/github/logout',
    (req, res) => {

        req.session.destroy(
            () => {

                res.json({
                    success:
                        true
                });
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| GITHUB USER
|--------------------------------------------------------------------------
*/

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

        res.json({
            success:
                false
        });
    }
);

/*
|--------------------------------------------------------------------------
| GITHUB REPOSITORIES
|--------------------------------------------------------------------------
*/

app.get(
    '/api/github/repos',
    async (req, res) => {

        const githubToken =
            req.session.githubToken;

        if (!githubToken) {

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

            if (
                !response.ok
            ) {

                throw new Error(
                    `GitHub API kļūda: ${response.status}`
                );
            }

            const repos =
                await response.json();

            if (
                !Array.isArray(repos)
            ) {

                throw new Error(
                    'GitHub repo response nav masīvs'
                );
            }

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

                success:
                    true,

                repos:
                    repoList
            });

        } catch (error) {

            console.error(
                'Repo saraksta kļūda:',
                error
            );

            res.status(500).json({

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

                    success:
                        false,

                    error:
                        'Nav repo'
                });
            }

            if (!walletAddress) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav wallet'
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
                await nftContract
                    .repositoryTokens(
                        repoHash
                    );

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
                tokenId !== 0n
            ) {

                const nftOwner =
                    await nftContract
                        .ownerOf(
                            tokenId
                        );

                if (
                    nftOwner.toLowerCase() ===
                    walletAddress.toLowerCase()
                ) {

                    hasNFT =
                        true;
                }
            }

            if (
                hasNFT
            ) {

                if (
                    SUBSCRIPTION_ADDRESS
                ) {

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

                if (
                    REGISTRY_ADDRESS
                ) {

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
                            errorMessage(
                                error
                            )
                        );
                    }
                }
            }

            res.json({

                success:
                    true,

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

/*
|--------------------------------------------------------------------------
| PREPARE BACKUP
|--------------------------------------------------------------------------
|
| SVARĪGĀKĀ IZMAIŅA:
|
| Turbo:
|
|     getUploadCosts({
|         bytes: [totalBytes]
|     })
|
| atgriež:
|
|     {
|         winc,
|         adjustments,
|         fees
|     }
|
| Nevis:
|
|     tokenAmount
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

                    success:
                        false,

                    error:
                        'Nav repo nosaukuma'
                });
            }

            if (!walletAddress) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav wallet adreses'
                });
            }

            if (!ethers.isAddress(walletAddress)) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nederīga wallet adrese'
                });
            }

            if (!githubToken) {

                return res.status(401).json({

                    success:
                        false,

                    error:
                        'Nav GitHub autorizācijas'
                });
            }

            if (!RPC_URL) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'RPC_URL nav konfigurēts'
                });
            }

            if (!NFT_ADDRESS) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'NFT_ADDRESS nav konfigurēts'
                });
            }

            if (!SUBSCRIPTION_ADDRESS) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'SUBSCRIPTION_ADDRESS nav konfigurēts'
                });
            }

            if (!REGISTRY_ADDRESS) {

                return res.status(500).json({

                    success:
                        false,

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
                getProvider();

            /*
             * ------------------------------------------------------
             * REPO HASH
             * ------------------------------------------------------
             */

            const repoHash =
                getRepositoryHash(
                    repoName
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

            if (
                tokenId === 0n
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav NFT šim repo'
                });
            }

            /*
             * ------------------------------------------------------
             * OWNER
             * ------------------------------------------------------
             */

            const nftOwner =
                await nftContract
                    .ownerOf(
                        tokenId
                    );

            if (
                nftOwner.toLowerCase() !==
                walletAddress.toLowerCase()
            ) {

                return res.status(403).json({

                    success:
                        false,

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

            if (
                !isSubscribed
            ) {

                return res.status(400).json({

                    success:
                        false,

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

                    success:
                        false,

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
             * PREVIOUS MANIFEST
             * ------------------------------------------------------
             */

            let previousManifest =
                null;

            if (
                backupCount > 0
            ) {

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
                        manifestURI.slice(
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
                                'Manifest gateway HTTP:',
                                manifestResponse.status
                            );
                        }

                    } catch (error) {

                        console.warn(
                            'Neizdevās iegūt iepriekšējo manifestu:',
                            errorMessage(
                                error
                            )
                        );
                    }
                }
            }

            /*
             * ------------------------------------------------------
             * REPO NAME
             * ------------------------------------------------------
             */

            const repoParts =
                repoName.split('/');

            if (
                repoParts.length !== 2
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Repo jābūt owner/repository formātā'
                });
            }

            const owner =
                repoParts[0];

            const repo =
                repoParts[1];

            /*
             * ------------------------------------------------------
             * CURRENT FILES
             * ------------------------------------------------------
             */

            console.log(
                'Lasām GitHub repo:',
                repoName
            );

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    owner,
                    repo
                );

            console.log(
                'GitHub faili:',
                currentFiles.length
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

            /*
             * ------------------------------------------------------
             * PREVIOUS PATHS
             * ------------------------------------------------------
             */

            const previousPaths =
                previousManifest &&
                previousManifest.paths &&
                typeof previousManifest.paths ===
                    'object'
                    ? previousManifest.paths
                    : {};

            /*
             * ------------------------------------------------------
             * DIFF
             * ------------------------------------------------------
             *
             * SVARĪGI:
             *
             * Iepriekšējā versija salīdzināja tikai
             * faila eksistenci.
             *
             * Tas nozīmē:
             *
             * fails mainījās
             *        ↓
             * tomēr tika uzskatīts par unchanged.
             *
             * Tagad salīdzinām arī SHA-256 hash.
             *
             */

            const changedFiles =
                [];

            const unchangedFiles =
                {};

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

            console.log(
                'Changed files:',
                changedFiles.length
            );

            console.log(
                'Unchanged files:',
                Object.keys(
                    unchangedFiles
                ).length
            );

            console.log(
                'Changed bytes:',
                totalBytes
            );

            /*
             * ------------------------------------------------------
             * NO CHANGES
             * ------------------------------------------------------
             */

            if (
                totalBytes === 0
            ) {

                return res.json({

                    success:
                        true,

                    repoName,

                    tokenId:
                        tokenId.toString(),

                    files:
                        [],

                    unchangedFiles,

                    fileCount:
                        0,

                    totalBytes:
                        0,

                    costWinc:
                        '0',

                    costEth:
                        '0',

                    hasPreviousBackup:
                        backupCount > 0,

                    backupCount,

                    message:
                        'Nav izmaiņu'
                });
            }

            /*
             * ------------------------------------------------------
             * TURBO CLIENT
             * ------------------------------------------------------
             */

            const turbo =
                getTurbo();

            /*
             * ------------------------------------------------------
             * GET UPLOAD COST
             * ------------------------------------------------------
             *
             * ŠIS IR GALVENAIS LABOJUMS.
             *
             * bytes MUST be array.
             *
             * ------------------------------------------------------
             */

            console.log(
                'Turbo getUploadCosts bytes:',
                [totalBytes]
            );

            const costs =
                await turbo.getUploadCosts({

                    bytes:
                        [
                            totalBytes
                        ]
                });

            console.log(
                'Turbo getUploadCosts result:'
            );

            console.dir(
                costs,
                {
                    depth:
                        null
                }
            );

            /*
             * ------------------------------------------------------
             * VALIDATE COST RESPONSE
             * ------------------------------------------------------
             */

            if (
                !Array.isArray(
                    costs
                )
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
                    'Turbo costInfo nav pieejams'
                );
            }

            /*
             * ------------------------------------------------------
             * WINC
             * ------------------------------------------------------
             */

            if (
                costInfo.winc ===
                    undefined ||
                costInfo.winc ===
                    null
            ) {

                throw new Error(
                    'Turbo getUploadCosts rezultātā nav winc'
                );
            }

            const costWinc =
                BigInt(
                    String(
                        costInfo.winc
                    )
                );

            /*
             * ------------------------------------------------------
             * IMPORTANT:
             *
             * winc NAV ETH.
             *
             * Tāpēc:
             *
             * ethers.formatEther(costWinc)
             *
             * IR NEPAREIZI.
             *
             * ------------------------------------------------------
             */

            /*
             * ------------------------------------------------------
             * TURBO BALANCE
             * ------------------------------------------------------
             *
             * Pārbaudām operatora Turbo kredītu rezervi.
             *
             * Šeit netiek pārsūtīts neviens ETH.
             *
             * ------------------------------------------------------
             */

            let turboBalanceWinc =
                null;

            try {

                const balance =
                    await turbo.getBalance();

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceWinc =
                        BigInt(
                            String(
                                balance.winc
                            )
                        );
                }

            } catch (error) {

                console.warn(
                    'Turbo balance pārbaude neizdevās:',
                    errorMessage(
                        error
                    )
                );
            }

            /*
             * ------------------------------------------------------
             * RESERVE CHECK
             * ------------------------------------------------------
             */

            if (
                turboBalanceWinc !==
                    null
            ) {

                const requiredWinc =
                    costWinc +
                    TURBO_MIN_RESERVE_WINC;

                if (
                    turboBalanceWinc <
                    requiredWinc
                ) {

                    return res.status(503).json({

                        success:
                            false,

                        error:
                            'Turbo kredītu rezerve nav pietiekama',

                        code:
                            'INSUFFICIENT_TURBO_CREDITS',

                        costWinc:
                            costWinc.toString(),

                        turboBalanceWinc:
                            turboBalanceWinc.toString(),

                        requiredWinc:
                            requiredWinc.toString(),

                        minReserveWinc:
                            TURBO_MIN_RESERVE_WINC
                                .toString()
                    });
                }
            }

            /*
             * ------------------------------------------------------
             * RESPONSE
             * ------------------------------------------------------
             *
             * costEth intentionally nav šeit.
             *
             * Mēs neizliekamies, ka winc = wei.
             *
             * ------------------------------------------------------
             */

            return res.json({

                success:
                    true,

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

                costWinc:
                    costWinc.toString(),

                turboCost: {

                    token:
                        TURBO_TOKEN,

                    winc:
                        costWinc.toString(),

                    bytes:
                        totalBytes
                },

                turboBalanceWinc:
                    turboBalanceWinc !==
                        null
                        ? turboBalanceWinc.toString()
                        : null,

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

/*
|--------------------------------------------------------------------------
| EXECUTE BACKUP
|--------------------------------------------------------------------------
|
| SVARĪGI:
|
| Šeit NAV:
|
|     Treasury.payTurbo()
|
| Šeit NAV:
|
|     Treasury -> Operator EOA
|
| Šeit NAV:
|
|     turbo.topUpWithTokens()
|
| Backup izmanto jau esošos Turbo kredītus.
|
| Lietotāja maksājums uz Treasury ir atsevišķa
| ekonomiskā plūsma.
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
                costWinc,
                walletAddress
            } = req.body;

            /*
             * ------------------------------------------------------
             * VALIDATION
             * ------------------------------------------------------
             */

            if (!repoName) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav repoName'
                });
            }

            if (!walletAddress) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav walletAddress'
                });
            }

            if (
                !ethers.isAddress(
                    walletAddress
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nederīga walletAddress'
                });
            }

            if (
                !Array.isArray(
                    files
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'files nav masīvs'
                });
            }

            if (
                !unchangedFiles ||
                typeof unchangedFiles !==
                    'object'
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav unchangedFiles'
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

            if (
                costWinc ===
                    undefined ||
                costWinc ===
                    null
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav costWinc'
                });
            }

            /*
             * ------------------------------------------------------
             * COST
             * ------------------------------------------------------
             */

            const requiredWinc =
                BigInt(
                    String(
                        costWinc
                    )
                );

            /*
             * ------------------------------------------------------
             * PROVIDER
             * ------------------------------------------------------
             */

            const provider =
                getProvider();

            /*
             * ------------------------------------------------------
             * NFT REVALIDATION
             * ------------------------------------------------------
             *
             * Nekad neuzticamies klienta:
             *
             *     tokenId
             *     costWinc
             *     repoName
             *
             * bez pārbaudes.
             *
             * ------------------------------------------------------
             */

            if (
                !NFT_ADDRESS
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'NFT_ADDRESS nav konfigurēts'
                });
            }

            if (
                !SUBSCRIPTION_ADDRESS
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'SUBSCRIPTION_ADDRESS nav konfigurēts'
                });
            }

            if (
                !REGISTRY_ADDRESS
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'REGISTRY_ADDRESS nav konfigurēts'
                });
            }

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
                await nftContract
                    .repositoryTokens(
                        repoHash
                    );

            if (
                onChainTokenId ===
                0n
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Repo NFT vairs nepastāv'
                });
            }

            if (
                onChainTokenId.toString() !==
                String(tokenId)
            ) {

                return res.status(409).json({

                    success:
                        false,

                    error:
                        'tokenId vairs neatbilst repo'
                });
            }

            /*
             * ------------------------------------------------------
             * OWNER
             * ------------------------------------------------------
             */

            const nftOwner =
                await nftContract
                    .ownerOf(
                        onChainTokenId
                    );

            if (
                nftOwner.toLowerCase() !==
                walletAddress.toLowerCase()
            ) {

                return res.status(403).json({

                    success:
                        false,

                    error:
                        'NFT nepieder wallet adresei'
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
                        onChainTokenId
                    );

            if (
                !isSubscribed
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Abonements vairs nav aktīvs'
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
                        onChainTokenId
                    );

            if (
                repoId ===
                ethers.ZeroHash
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Repo nav reģistrēts Registry'
                });
            }

            /*
             * ------------------------------------------------------
             * TURBO
             * ------------------------------------------------------
 */

            const turbo =
                getTurbo();

            /*
             * ------------------------------------------------------
             * CURRENT TURBO BALANCE
             * ------------------------------------------------------
 */

            const turboBalance =
                await turbo.getBalance();

            if (
                !turboBalance ||
                turboBalance.winc ===
                    undefined
            ) {

                throw new Error(
                    'Turbo getBalance neatgrieza winc'
                );
            }

            const availableWinc =
                BigInt(
                    String(
                        turboBalance.winc
                    )
                );

            /*
             * ------------------------------------------------------
             * CHECK BALANCE
             * ------------------------------------------------------
 */

            if (
                availableWinc <
                requiredWinc
            ) {

                return res.status(503).json({

                    success:
                        false,

                    error:
                        'Turbo kredītu nepietiek backup izpildei',

                    code:
                        'INSUFFICIENT_TURBO_CREDITS',

                    requiredWinc:
                        requiredWinc.toString(),

                    availableWinc:
                        availableWinc.toString()
                });
            }

            /*
             * ------------------------------------------------------
             * UPLOAD FILES
             * ------------------------------------------------------
 */

            const uploadResults =
                [];

            for (
                const file
                of files
            ) {

                if (
                    !file.path
                ) {

                    throw new Error(
                        'Backup failam nav path'
                    );
                }

                if (
                    !file.content
                ) {

                    throw new Error(
                        `Backup failam nav content: ${file.path}`
                    );
                }

                const fileBuffer =
                    Buffer.from(
                        file.content,
                        'base64'
                    );

                console.log(
                    'Augšupielādē:',
                    file.path
                );

                const result =
                    await turbo.uploadFile({

                        fileStreamFactory:
                            () =>
                                bufferToReadableStream(
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
                                        file.hash ||
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
                        `Turbo neatgrieza transaction ID failam: ${file.path}`
                    );
                }

                uploadResults.push({

                    path:
                        file.path,

                    txId:
                        result.id,

                    size:
                        fileBuffer.length,

                    hash:
                        file.hash ||
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
             * NEW FILES
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
             * UNCHANGED FILES
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

                if (
                    info &&
                    info.txId
                ) {

                    manifest.paths[
                        filePath
                    ] = {

                        id:
                            info.txId
                    };
                }
            }

            /*
             * ------------------------------------------------------
             * INDEX
             * ------------------------------------------------------
 */

            const manifestPaths =
                Object.keys(
                    manifest.paths
                );

            if (
                manifestPaths.length > 0
            ) {

                if (
                    manifest.paths[
                        'README.md'
                    ]
                ) {

                    manifest.index = {

                        path:
                            'README.md'
                    };

                } else {

                    manifest.index = {

                        path:
                            manifestPaths[0]
                    };
                }
            }

            /*
             * ------------------------------------------------------
             * MANIFEST BUFFER
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
                            bufferToReadableStream(
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
                    'Turbo neatgrieza manifest transaction ID'
                );
            }

            /*
             * ------------------------------------------------------
             * FINAL BALANCE
             * ------------------------------------------------------
 */

            let turboBalanceAfter =
                null;

            try {

                const after =
                    await turbo.getBalance();

                if (
                    after &&
                    after.winc !==
                        undefined
                ) {

                    turboBalanceAfter =
                        BigInt(
                            String(
                                after.winc
                            )
                        );
                }

            } catch (error) {

                console.warn(
                    'Turbo balance pēc upload neizdevās:',
                    errorMessage(
                        error
                    )
                );
            }

            /*
             * ------------------------------------------------------
             * RESPONSE
             * ------------------------------------------------------
 */

            return res.json({

                success:
                    true,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                costWinc:
                    requiredWinc.toString(),

                turboBalanceBefore:
                    availableWinc.toString(),

                turboBalanceAfter:
                    turboBalanceAfter !==
                        null
                        ? turboBalanceAfter.toString()
                        : null
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

/*
|--------------------------------------------------------------------------
| CONTENT TYPE
|--------------------------------------------------------------------------
*/

function getContentType(
    filePath
) {

    const lower =
        filePath
            .toLowerCase();

    if (
        lower.endsWith(
            '.json'
        )
    ) {

        return 'application/json';
    }

    if (
        lower.endsWith(
            '.html'
        )
    ) {

        return 'text/html';
    }

    if (
        lower.endsWith(
            '.css'
        )
    ) {

        return 'text/css';
    }

    if (
        lower.endsWith(
            '.js'
        ) ||
        lower.endsWith(
            '.mjs'
        )
    ) {

        return 'application/javascript';
    }

    if (
        lower.endsWith(
            '.ts'
        )
    ) {

        return 'text/plain';
    }

    if (
        lower.endsWith(
            '.md'
        )
    ) {

        return 'text/markdown';
    }

    if (
        lower.endsWith(
            '.xml'
        )
    ) {

        return 'application/xml';
    }

    if (
        lower.endsWith(
            '.svg'
        )
    ) {

        return 'image/svg+xml';
    }

    if (
        lower.endsWith(
            '.png'
        )
    ) {

        return 'image/png';
    }

    if (
        lower.endsWith(
            '.jpg'
        ) ||
        lower.endsWith(
            '.jpeg'
        )
    ) {

        return 'image/jpeg';
    }

    if (
        lower.endsWith(
            '.gif'
        )
    ) {

        return 'image/gif';
    }

    if (
        lower.endsWith(
            '.webp'
        )
    ) {

        return 'image/webp';
    }

    if (
        lower.endsWith(
            '.pdf'
        )
    ) {

        return 'application/pdf';
    }

    return 'application/octet-stream';
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

    const files =
        [];

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

    if (
        !response.ok
    ) {

        const text =
            await response.text();

        throw new Error(
            `GitHub API kļūda: ${response.status} ${text}`
        );
    }

    const contents =
        await response.json();

    /*
     * GitHub var atgriezt object,
     * ja pieprasītais path ir viens fails.
     */

    if (
        !Array.isArray(
            contents
        )
    ) {

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
            item.type ===
            'file'
        ) {

            const size =
                Number(
                    item.size ||
                    0
                );

            /*
             * GitHub Contents API
             * failiem līdz 100 MB.
             */

            if (
                size >
                104857600
            ) {

                console.warn(
                    'Fails pārsniedz 100 MB:',
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
                                `Bearer ${githubToken}`,

                            Accept:
                                'application/octet-stream'
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
                    await fileResponse
                        .arrayBuffer()
                );

            const hash =
                crypto
                    .createHash(
                        'sha256'
                    )
                    .update(
                        fileBuffer
                    )
                    .digest(
                        'hex'
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

                hash
            });

        /*
         * ------------------------------------------------------
         * DIRECTORY
         * ------------------------------------------------------
 */

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

/*
|--------------------------------------------------------------------------
| TURBO STATUS
|--------------------------------------------------------------------------
*/

app.get(
    '/api/turbo/status',
    async (req, res) => {

        try {

            if (
                !OPERATOR_PRIVATE_KEY
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'OPERATOR_PRIVATE_KEY nav konfigurēts'
                });
            }

            const turbo =
                getTurbo();

            const balance =
                await turbo.getBalance();

            const winc =
                balance &&
                balance.winc !==
                    undefined
                    ? BigInt(
                        String(
                            balance.winc
                        )
                    )
                    : null;

            const operatorWallet =
                new ethers.Wallet(
                    OPERATOR_PRIVATE_KEY
                );

            res.json({

                success:
                    true,

                operatorAddress:
                    operatorWallet.address,

                token:
                    TURBO_TOKEN,

                winc:
                    winc !== null
                        ? winc.toString()
                        : null,

                minReserveWinc:
                    TURBO_MIN_RESERVE_WINC
                        .toString(),

                uploadService:
                    TURBO_UPLOAD_URL,

                paymentService:
                    TURBO_PAYMENT_URL
            });

        } catch (error) {

            console.error(
                'Turbo status kļūda:',
                error
            );

            res.status(500).json({

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

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    '/api/health',
    async (req, res) => {

        let operatorAddress =
            null;

        let turboBalanceWinc =
            null;

        /*
         * ------------------------------------------------------
         * OPERATOR ADDRESS
         * ------------------------------------------------------
 */

        if (
            OPERATOR_PRIVATE_KEY
        ) {

            try {

                const wallet =
                    new ethers.Wallet(
                        OPERATOR_PRIVATE_KEY
                    );

                operatorAddress =
                    wallet.address;

            } catch (error) {

                operatorAddress =
                    null;
            }
        }

        /*
         * ------------------------------------------------------
         * TURBO BALANCE
         * ------------------------------------------------------
 */

        if (
            OPERATOR_PRIVATE_KEY
        ) {

            try {

                const turbo =
                    getTurbo();

                const balance =
                    await turbo.getBalance();

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceWinc =
                        BigInt(
                            String(
                                balance.winc
                            )
                        ).toString();
                }

            } catch (error) {

                console.warn(
                    'Health Turbo balance kļūda:',
                    errorMessage(
                        error
                    )
                );
            }
        }

        /*
         * ------------------------------------------------------
         * RESPONSE
         * ------------------------------------------------------
 */

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
                    TURBO_PAYMENT_URL,

                turboBalanceWinc
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
            'TURBO_MIN_RESERVE_WINC:',
            TURBO_MIN_RESERVE_WINC.toString()
        );

        console.log(
            '========================================'
        );
    }
);

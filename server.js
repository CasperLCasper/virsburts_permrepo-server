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
| LIMITS
|--------------------------------------------------------------------------
*/

const MAX_FILE_SIZE =
    100 * 1024 * 1024;

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
 * Validē Ethereum adresi.
 */
function isValidAddress(address) {

    if (
        typeof address !== 'string'
    ) {
        return false;
    }

    return ethers.isAddress(
        address
    );
}

/**
 * Validē repository nosaukumu:
 *
 * owner/repository
 */
function parseRepoName(repoName) {

    if (
        typeof repoName !== 'string'
    ) {
        throw new Error(
            'repoName jābūt string'
        );
    }

    const value =
        repoName.trim();

    const parts =
        value.split('/');

    if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
    ) {

        throw new Error(
            'Repo jābūt formātā owner/repository'
        );
    }

    return {

        owner:
            parts[0],

        repo:
            parts[1]
    };
}

/**
 * Repository hash.
 */
function getRepositoryHash(repoName) {

    return ethers.keccak256(
        ethers.AbiCoder
            .defaultAbiCoder()
            .encode(
                ['string'],
                [repoName]
            )
    );
}

/**
 * Izveido Node/Web ReadableStream no Buffer.
 *
 * Turbo SDK uploadFile pieņem stream factory.
 */
function bufferToReadableStream(
    buffer
) {

    return new ReadableStream({

        start(controller) {

            controller.enqueue(
                new Uint8Array(buffer)
            );

            controller.close();
        }
    });
}

/**
 * Droši iegūst Turbo token amount.
 *
 * Dažādām SDK versijām atbildes struktūra
 * var atšķirties.
 */
function extractTurboTokenAmount(
    costInfo
) {

    if (
        !costInfo
    ) {

        throw new Error(
            'Turbo costInfo nav saņemts'
        );
    }

    /*
     * Ja konkrētā SDK versija atgriež
     * tokenAmount.
     */
    if (
        costInfo.tokenAmount !==
        undefined &&
        costInfo.tokenAmount !==
        null
    ) {

        return BigInt(
            costInfo.tokenAmount.toString()
        );
    }

    /*
     * Ja SDK atgriež winc,
     * tas nav tas pats, kas base-eth wei.
     *
     * Tāpēc to NEKONVERTĒJAM automātiski
     * par ETH.
     */
    if (
        costInfo.winc !==
        undefined &&
        costInfo.winc !==
        null
    ) {

        throw new Error(
            'Turbo atgrieza winc cenu, nevis tokenAmount. Šī SDK versija/konfigurācija neatgriež tiešu base-eth tokenAmount.'
        );
    }

    throw new Error(
        'Turbo izmaksu rezultātā nav tokenAmount vai winc'
    );
}

/*
|--------------------------------------------------------------------------
| CONFIG API
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
                ARWEAVE_GATEWAY
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

        if (
            !code
        ) {

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
                    'GitHub repos atbilde nav masīvs'
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
                    error.message
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

            if (
                !repoName
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav repo'
                });
            }

            if (
                !walletAddress
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav wallet'
                });
            }

            if (
                !isValidAddress(
                    walletAddress
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nederīga wallet adrese'
                });
            }

            if (
                !RPC_URL
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'RPC_URL nav konfigurēts'
                });
            }

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

            const provider =
                new ethers.JsonRpcProvider(
                    RPC_URL
                );

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
                    await nftContract.ownerOf(
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
                            error.message
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
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| PREPARE BACKUP
|--------------------------------------------------------------------------
|
| ŠIS ENDPOINTS NEVEIC NEVIENU MAKSĀJUMU.
|
| Tas:
|
| 1. pārbauda GitHub autorizāciju;
| 2. pārbauda NFT;
| 3. pārbauda NFT owner;
| 4. pārbauda subscription;
| 5. pārbauda Registry;
| 6. nolasa iepriekšējo manifestu;
| 7. nolasa GitHub failus;
| 8. salīdzina failus;
| 9. aprēķina Turbo cenu.
|
|--------------------------------------------------------------------------
*/

app.post(
    '/api/prepare-backup',
    async (req, res) => {

        try {

            console.log(
                '========================================'
            );

            console.log(
                'PREPARE BACKUP'
            );

            console.log(
                '========================================'
            );

            const {
                repoName,
                walletAddress
            } = req.body;

            const githubToken =
                req.session.githubToken;

            /*
             * ------------------------------------------------------
             * VALIDATION
             * ------------------------------------------------------
             */

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
                !isValidAddress(
                    walletAddress
                )
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nederīga wallet adrese'
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

            if (
                !RPC_URL
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'RPC_URL nav konfigurēts'
                });
            }

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

            /*
             * ------------------------------------------------------
             * REPO
             * ------------------------------------------------------
             */

            const {
                owner,
                repo
            } =
                parseRepoName(
                    repoName
                );

            console.log(
                'Repository:',
                repoName
            );

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
                getRepositoryHash(
                    repoName
                );

            console.log(
                'Repository hash:',
                repoHash
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

            console.log(
                'Token ID:',
                tokenId.toString()
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

            console.log(
                'NFT owner:',
                nftOwner
            );

            console.log(
                'Wallet:',
                walletAddress
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

            console.log(
                'Subscription:',
                isSubscribed
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

            console.log(
                'Registry repo ID:',
                repoId
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

            console.log(
                'Backup count:',
                backupCount
            );

            /*
             * ------------------------------------------------------
             * PREVIOUS MANIFEST
             * ------------------------------------------------------
             */

            let previousManifest =
                null;

            let previousManifestURI =
                null;

            if (
                backupCount > 0
            ) {

                previousManifestURI =
                    await nftContract
                        .getManifestURI(
                            tokenId
                        );

                console.log(
                    'Previous manifest URI:',
                    previousManifestURI
                );

                if (
                    previousManifestURI &&
                    previousManifestURI
                        .startsWith(
                            'ar://'
                        )
                ) {

                    const txId =
                        previousManifestURI
                            .substring(
                                5
                            );

                    const manifestURL =
                        `${ARWEAVE_GATEWAY}/${txId}`;

                    console.log(
                        'Fetching manifest:',
                        manifestURL
                    );

                    try {

                        const manifestResponse =
                            await fetch(
                                manifestURL
                            );

                        if (
                            manifestResponse.ok
                        ) {

                            previousManifest =
                                await manifestResponse
                                    .json();

                            console.log(
                                'Previous manifest loaded.'
                            );

                        } else {

                            console.warn(
                                'Manifest HTTP status:',
                                manifestResponse.status
                            );
                        }

                    } catch (error) {

                        console.warn(
                            'Manifest fetch kļūda:',
                            error.message
                        );
                    }
                }
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

            console.log(
                'Previous manifest paths:',
                Object.keys(
                    previousPaths
                ).length
            );

            /*
             * ------------------------------------------------------
             * GITHUB FILES
             * ------------------------------------------------------
             */

            console.log(
                'Reading GitHub repository...'
            );

            const currentFiles =
                await getRepoFiles(
                    githubToken,
                    owner,
                    repo
                );

            console.log(
                'GitHub files:',
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
             * COMPARE FILES
             * ------------------------------------------------------
             *
             * ĻOTI SVARĪGI:
             *
             * Iepriekšējais kods pārbaudīja tikai:
             *
             * previousFile.id
             *
             * Tas nozīmē, ka fails ar mainītu
             * saturu varēja kļūdaini tikt uzskatīts
             * par unchanged.
             *
             * Tagad salīdzinām SHA-256 hash.
             *
             * ------------------------------------------------------
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

                /*
                 * Ja iepriekšējā manifestā ir fails
                 * un mums ir hash metadata,
                 * salīdzinām hash.
                 */

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

                    continue;
                }

                /*
                 * Backward compatibility:
                 *
                 * Vecajos manifestos hash var nebūt.
                 *
                 * Tādā gadījumā mēs NEUZSKATĀM failu
                 * par unchanged.
                 *
                 * Tas ir drošāk.
                 */

                changedFiles.push(
                    file
                );
            }

            /*
             * ------------------------------------------------------
             * DELETED FILES
             * ------------------------------------------------------
             *
             * Ja fails iepriekšējā manifestā eksistēja,
             * bet GitHub repo vairs nav, tas netiek
             * pievienots jaunajam manifestam.
             *
             * Tādējādi jaunais manifests reprezentē
             * pašreizējo repo stāvokli.
             * ------------------------------------------------------
             */

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
                                file.size ||
                                0
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
                'Total changed bytes:',
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

                    costEth:
                        '0',

                    turboCost:
                        null,

                    hasPreviousBackup:
                        backupCount > 0,

                    backupCount,

                    previousManifestURI,

                    message:
                        'Nav izmaiņu'
                });
            }

            /*
             * ------------------------------------------------------
             * TURBO PRICE CLIENT
             * ------------------------------------------------------
             *
             * Cena nav jāaprēķina ar operatora privāto
             * atslēgu.
             *
             * getUploadCosts ir payment service
             * price query.
             *
             * ------------------------------------------------------
             */

            console.log(
                'Creating unauthenticated Turbo client for pricing...'
            );

            const turbo =
                TurboFactory.unauthenticated({

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
             * GET UPLOAD COSTS
             * ------------------------------------------------------
             *
             * SVARĪGI:
             *
             * bytes MUST be number[].
             *
             * Pareizi:
             *
             * {
             *     bytes: [totalBytes]
             * }
             *
             * Nepareizi:
             *
             * {
             *     bytes: totalBytes
             * }
             *
             * Jo SDK iekšēji izmanto .map().
             * ------------------------------------------------------
             */

            console.log(
                'Requesting Turbo upload costs for bytes:',
                totalBytes
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
             * COST VALIDATION
             * ------------------------------------------------------
             */

            if (
                !Array.isArray(
                    costs
                )
            ) {

                throw new Error(
                    `Turbo getUploadCosts neatgrieza masīvu. Saņemts: ${typeof costs}`
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
                    'Turbo costInfo nav definēts'
                );
            }

            console.log(
                'Turbo costInfo:'
            );

            console.dir(
                costInfo,
                {
                    depth:
                        null
                }
            );

            /*
             * ------------------------------------------------------
             * TOKEN AMOUNT
             * ------------------------------------------------------
             */

            let tokenAmount;

            try {

                tokenAmount =
                    extractTurboTokenAmount(
                        costInfo
                    );

            } catch (error) {

                /*
                 * Šeit negribam izlikties,
                 * ka winc = wei.
                 *
                 * Atgriežam ļoti konkrētu kļūdu.
                 */

                throw new Error(
                    `Turbo cenas formāts nav izmantojams kā tiešs ${TURBO_TOKEN} amount: ${error.message}`
                );
            }

            /*
             * ------------------------------------------------------
             * BASE ETH PRICE
             * ------------------------------------------------------
             */

            const costEth =
                ethers.formatEther(
                    tokenAmount
                );

            console.log(
                'Turbo token amount:',
                tokenAmount.toString()
            );

            console.log(
                'Turbo cost ETH:',
                costEth
            );

            /*
             * ------------------------------------------------------
             * RESPONSE
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

                backupCount,

                previousManifestURI
            });

        } catch (error) {

            console.error(
                '========================================'
            );

            console.error(
                'BACKUP PREPARE ERROR'
            );

            console.error(
                '========================================'
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
| Šeit tiek veikts:
|
|   Treasury.payTurbo()
|
| Operatora EOA:
|
|   tikai izsauc Treasury kontraktu.
|
| Operatora EOA nav lietotāja Treasury.
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

            } =
                req.body;

            /*
             * ------------------------------------------------------
             * VALIDATION
             * ------------------------------------------------------
             */

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
                !isValidAddress(
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
                costEth ===
                    undefined ||
                costEth ===
                    null
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'Nav costEth'
                });
            }

            if (
                !RPC_URL
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'RPC_URL nav konfigurēts'
                });
            }

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

            if (
                !TREASURY_ADDRESS
            ) {

                return res.status(500).json({

                    success:
                        false,

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
             * OPERATOR
             * ------------------------------------------------------
             */

            const operatorWallet =
                new ethers.Wallet(
                    OPERATOR_PRIVATE_KEY,
                    provider
                );

            console.log(
                'Operator:',
                operatorWallet.address
            );

            /*
             * ------------------------------------------------------
             * VERIFY TREASURY OPERATOR
             * ------------------------------------------------------
             *
             * Treasury kontraktā operator ir immutable.
             *
             * Šeit pārbaudām, ka servera private key
             * tiešām atbilst deploy laikā ievadītajam operator.
             * ------------------------------------------------------
             */

            const operatorAbi = [

                "function operator() external view returns (address)",

                "function turboPaymentAddress() external view returns (address)"
            ];

            const treasuryRead =
                new ethers.Contract(
                    TREASURY_ADDRESS,
                    [
                        ...TREASURY_ABI,
                        ...operatorAbi
                    ],
                    provider
                );

            const configuredOperator =
                await treasuryRead.operator();

            const turboPaymentAddress =
                await treasuryRead
                    .turboPaymentAddress();

            console.log(
                'Treasury configured operator:',
                configuredOperator
            );

            console.log(
                'Treasury Turbo payment address:',
                turboPaymentAddress
            );

            if (
                configuredOperator.toLowerCase() !==
                operatorWallet.address.toLowerCase()
            ) {

                return res.status(500).json({

                    success:
                        false,

                    error:
                        'OPERATOR_PRIVATE_KEY neatbilst Treasury operator adresei'
                });
            }

            /*
             * ------------------------------------------------------
             * COST
             * ------------------------------------------------------
             */

            let costWei;

            try {

                costWei =
                    ethers.parseEther(
                        String(
                            costEth
                        )
                    );

            } catch (error) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        `Nederīgs costEth: ${error.message}`
                });
            }

            if (
                costWei <= 0n
            ) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        'costEth jābūt > 0'
                });
            }

            /*
             * ------------------------------------------------------
             * TREASURY BALANCE
             * ------------------------------------------------------
             */

            const treasuryBalance =
                await treasuryRead.balance();

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

                    success:
                        false,

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
                ethers.keccak256(

                    ethers.solidityPacked(

                        [
                            'string',
                            'address',
                            'uint256',
                            'uint256'
                        ],

                        [
                            repoName,

                            walletAddress,

                            BigInt(
                                tokenId
                            ),

                            BigInt(
                                Date.now()
                            )
                        ]
                    )
                );

            console.log(
                'Payment ID:',
                paymentId
            );

            /*
             * ------------------------------------------------------
             * TREASURY PAYMENT
             * ------------------------------------------------------
             *
             * SVARĪGI:
             *
             * Operatora EOA NEŅEM Treasury ETH.
             *
             * Operatora EOA tikai izsauc:
             *
             *   Treasury.payTurbo()
             *
             * Treasury pats nosūta ETH uz:
             *
             *   turboPaymentAddress
             *
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
                await treasuryWrite
                    .payTurbo(
                        costWei,
                        paymentId
                    );

            console.log(
                'Treasury payment tx:',
                payTx.hash
            );

            const payReceipt =
                await payTx.wait();

            console.log(
                'Treasury maksājums apstiprināts:',
                payReceipt.hash
            );

            /*
             * ------------------------------------------------------
             * TURBO CLIENT
             * ------------------------------------------------------
             *
             * Šeit tiek izmantots operator signer tikai
             * datu item parakstīšanai.
             *
             * Mēs NEIZSAUCAM topUpWithTokens().
             *
             * ------------------------------------------------------
             */

            const signer =
                new EthereumSigner(
                    OPERATOR_PRIVATE_KEY
                );

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
             * TURBO BALANCE
             * ------------------------------------------------------
             */

            let turboBalanceBefore =
                null;

            try {

                const balance =
                    await turbo.getBalance();

                console.log(
                    'Turbo balance before:',
                    balance
                );

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceBefore =
                        balance.winc.toString();
                }

            } catch (error) {

                console.warn(
                    'Turbo balance pārbaude neizdevās:',
                    error.message
                );
            }

            /*
             * ------------------------------------------------------
             * IMPORTANT PAYMENT MODEL WARNING
             * ------------------------------------------------------
             *
             * Treasury payment jau ir veikts.
             *
             * Tāpēc:
             *
             * turbo.topUpWithTokens()
             *
             * ŠEIT NEDRĪKST IZSAUKT.
             *
             * ------------------------------------------------------
             */

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
                    file.path
                );

                console.log(
                    'Size:',
                    fileBuffer.length
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
                                        'application/octet-stream'
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
                        `Turbo upload neatgrieza transaction ID failam ${file.path}`
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

                paths:
                    {},

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
             * INDEX
             * ------------------------------------------------------
             */

            let indexPath =
                null;

            if (
                uploadResults.some(
                    file =>
                        file.path ===
                        'README.md'
                )
            ) {

                indexPath =
                    'README.md';

            } else {

                const allPaths =
                    [
                        ...uploadResults
                            .map(
                                file =>
                                    file.path
                            ),

                        ...Object.keys(
                            unchangedFiles
                        )
                    ];

                if (
                    allPaths.length > 0
                ) {

                    indexPath =
                        allPaths[0];
                }
            }

            if (
                indexPath
            ) {

                manifest.index = {

                    path:
                        indexPath
                };
            }

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
             * MANIFEST BUFFER
             * ------------------------------------------------------
             */

            const manifestBuffer =
                Buffer.from(

                    JSON.stringify(
                        manifest,
                        null,
                        2
                    ),

                    'utf8'
                );

            console.log(
                'Manifest size:',
                manifestBuffer.length
            );

            /*
             * ------------------------------------------------------
             * MANIFEST UPLOAD
             * ------------------------------------------------------
             */

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
                    'Turbo manifest upload neatgrieza transaction ID'
                );
            }

            /*
             * ------------------------------------------------------
             * TURBO BALANCE AFTER
             * ------------------------------------------------------
             */

            let turboBalanceAfter =
                null;

            try {

                const balance =
                    await turbo.getBalance();

                console.log(
                    'Turbo balance after:',
                    balance
                );

                if (
                    balance &&
                    balance.winc !==
                        undefined
                ) {

                    turboBalanceAfter =
                        balance.winc.toString();
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

            return res.json({

                success:
                    true,

                manifestTxId:
                    manifestResult.id,

                uploadedFiles:
                    uploadResults,

                costEth:
                    String(
                        costEth
                    ),

                paymentId,

                treasuryPaymentTx:
                    payTx.hash,

                turboPaymentAddress,

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
                '========================================'
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
                    error.message ||
                    'Nezināma kļūda'
            });
        }
    }
);

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

    let url;

    if (
        repoPath
    ) {

        const encodedPath =
            repoPath
                .split('/')
                .map(
                    part =>
                        encodeURIComponent(
                            part
                        )
                )
                .join('/');

        url =
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

    } else {

        url =
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
    }

    console.log(
        'GitHub contents:',
        url
    );

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

        let body = '';

        try {

            body =
                await response.text();

        } catch {

            body =
                '';
        }

        throw new Error(
            `GitHub API kļūda: ${response.status}${body ? ` - ${body}` : ''}`
        );
    }

    const contents =
        await response.json();

    if (
        !Array.isArray(
            contents
        )
    ) {

        /*
         * GitHub var atgriezt vienu file objektu,
         * nevis array.
         */

        if (
            contents &&
            contents.type ===
                'file'
        ) {

            return [
                await downloadGithubFile(
                    githubToken,
                    contents
                )
            ];
        }

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

            if (
                Number(
                    item.size ||
                    0
                ) >
                MAX_FILE_SIZE
            ) {

                console.warn(
                    'Fails pārsniedz 100 MB un tiek izlaists:',
                    item.path
                );

                continue;
            }

            const file =
                await downloadGithubFile(
                    githubToken,
                    item
                );

            files.push(
                file
            );

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
| DOWNLOAD GITHUB FILE
|--------------------------------------------------------------------------
*/

async function downloadGithubFile(
    githubToken,
    item
) {

    if (
        !item.download_url
    ) {

        throw new Error(
            `Failam nav download_url: ${item.path}`
        );
    }

    const response =
        await fetch(
            item.download_url,
            {

                headers: {

                    Authorization:
                        `Bearer ${githubToken}`,

                    Accept:
                        'application/vnd.github.v3.raw',

                    'X-GitHub-Api-Version':
                        '2022-11-28'
                }
            }
        );

    if (
        !response.ok
    ) {

        throw new Error(
            `GitHub faila lejupielādes kļūda: ${item.path} (${response.status})`
        );
    }

    const fileBuffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    if (
        fileBuffer.length >
        MAX_FILE_SIZE
    ) {

        console.warn(
            'Fails pēc lejupielādes pārsniedz 100 MB:',
            item.path
        );

        throw new Error(
            `Fails pārsniedz 100 MB limitu: ${item.path}`
        );
    }

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

    return {

        path:
            item.path,

        size:
            fileBuffer.length,

        content:
            fileBuffer.toString(
                'base64'
            ),

        hash
    };
}

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

        let treasuryOperator =
            null;

        let turboPaymentAddress =
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
         * TREASURY INFO
         * ------------------------------------------------------
 */

        if (
            RPC_URL &&
            TREASURY_ADDRESS
        ) {

            try {

                const provider =
                    new ethers.JsonRpcProvider(
                        RPC_URL
                    );

                const treasury =
                    new ethers.Contract(

                        TREASURY_ADDRESS,

                        [
                            "function operator() external view returns (address)",

                            "function turboPaymentAddress() external view returns (address)",

                            "function balance() external view returns (uint256)"
                        ],

                        provider
                    );

                treasuryOperator =
                    await treasury.operator();

                turboPaymentAddress =
                    await treasury
                        .turboPaymentAddress();

            } catch (error) {

                console.warn(
                    'Health Treasury read kļūda:',
                    error.message
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

                treasuryOperator,

                operatorMatchesTreasury:
                    !!(
                        operatorAddress &&
                        treasuryOperator &&
                        operatorAddress.toLowerCase() ===
                            treasuryOperator.toLowerCase()
                    ),

                turboPaymentAddress,

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

// merkle.js
// Merkle saknes (filesHash) aprēķināšana un iesniegšana NFT līgumā
// Calculation and submission of Merkle root (filesHash) to the NFT contract

import { ethers } from 'ethers';

/**
 * Aprēķina Merkle sakni (filesHash) no failu hešu saraksta.
 * Calculates the Merkle root (filesHash) from a list of file hashes.
 * 
 * @param {Array} files - failu masīvs ar lauku { hash: string }.
 *                         Array of files with field { hash: string }.
 * @returns {string} - keccak256(concat(all hashes)).
 */
export function calculateMerkleRoot(files) {
    // 1. Savāc visus failu hešus (tie jau ir SHA-256 no GitHub).
    //    Collect all file hashes (they are already SHA-256 from GitHub).
    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash))
    );

    // 2. Ja nav failu – atgriež nulles sakni.
    //    If no files – return zero root.
    if (fileHashes.length === 0) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }

    // 3. Apvieno visus hešus un aprēķina vienu sakni.
    //    Combine all hashes and calculate a single root.
    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );

    return combinedHash;
}

/**
 * Izsauc NFT līguma addBackup() funkciju ar reālu merkleRoot.
 * Calls the NFT contract's addBackup() function with a real merkleRoot.
 * 
 * @param {Object} params - { tokenId, manifestTxId, files, deadline, signature, nftContract, readContract, signerContract }.
 * @returns {Promise<string>} - transakcijas hash / transaction hash.
 */
export async function submitBackupWithMerkle(params) {
    const { 
        tokenId, 
        manifestTxId, 
        files, 
        deadline, 
        signature, 
        nftContract, 
        readContract, 
        signerContract 
    } = params;

    // 1. Aprēķini Merkle sakni.
    //    Calculate Merkle root.
    const merkleRoot = calculateMerkleRoot(files);

    // 2. Sagatavo manifest URI un hešu.
    //    Prepare manifest URI and hash.
    const manifestURI = `ar://${manifestTxId}`;
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));

    // 3. Iegūst pašreizējo nonce un backupNumber.
    //    Get current nonce and backupNumber.
    const currentNonce = await readContract.getNonce(tokenId);
    const backupNumber = await readContract.getBackupCount(tokenId);

    // 4. Pārbauda, vai paraksts jau nav sagatavots (ja nē – sagatavo jaunu).
    //    Check if signature is already prepared (if not – prepare a new one).
    let finalSignature = signature;
    let finalDeadline = deadline;

    if (!finalSignature) {
        // Ja paraksts netika nodots no priekšpuses, sagatavo jaunu EIP-712 parakstu.
        // If signature wasn't passed from the frontend, prepare a new EIP-712 signature.
        const domain = {
            name: 'PermRepo',
            version: '1',
            chainId: parseInt(process.env.CHAIN_ID, 16),
            verifyingContract: process.env.NFT_ADDRESS
        };

        const types = {
            AddBackup: [
                { name: 'tokenId', type: 'uint256' },
                { name: 'backupNumber', type: 'uint256' },
                { name: 'manifestHash', type: 'bytes32' },
                { name: 'merkleRoot', type: 'bytes32' },
                { name: 'deadline', type: 'uint256' },
                { name: 'nonce', type: 'uint256' }
            ]
        };

        const value = {
            tokenId: BigInt(tokenId),
            backupNumber: backupNumber + 1n,
            manifestHash,
            merkleRoot,
            deadline: BigInt(deadline || Math.floor(Date.now() / 1000) + 600),
            nonce: currentNonce
        };

        finalSignature = await signerContract.signTypedData(domain, types, value);
        finalDeadline = value.deadline;
    }

    // 5. Izsauc addBackup().
    //    Call addBackup().
    const tx = await nftContract.addBackup(
        tokenId,
        manifestHash,
        merkleRoot,
        manifestURI,
        finalDeadline,
        finalSignature
    );

    await tx.wait();
    return tx.hash;
}

// merkle.js
// Merkle saknes aprēķins un iesniegšana NFT līgumā
// Calculation and submission of Merkle root to the NFT contract

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
    if (!files || !Array.isArray(files) || files.length === 0) {
        return ethers.ZeroHash;
    }

    const fileHashes = files.map(file => 
        ethers.keccak256(ethers.toUtf8Bytes(file.hash || ''))
    );

    const combinedHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [fileHashes])
    );

    return combinedHash;
}

/**
 * Izsauc NFT līguma addBackup() funkciju ar reālu merkleRoot.
 * Calls the NFT contract's addBackup() function with a real merkleRoot.
 * 
 * @param {Object} params - { tokenId, manifestTxId, files, deadline, signature, nftContract }.
 * @returns {Promise<Object>} - { txHash, merkleRoot, manifestURI, manifestHash }.
 */
export async function submitBackupWithMerkle(params) {
    const { 
        tokenId, 
        manifestTxId, 
        files, 
        deadline, 
        signature, 
        nftContract
    } = params;

    console.log('\n' + '='.repeat(60));
    console.log('📝 SUBMIT BACKUP WITH MERKLE');
    console.log('='.repeat(60));
    console.log('   Token ID:', tokenId);
    console.log('   Manifest TX ID:', manifestTxId);
    console.log('   Files count:', files ? files.length : 0);

    // 1. Aprēķini Merkle sakni.
    //    Calculate Merkle root.
    const merkleRoot = calculateMerkleRoot(files);
    console.log('   Merkle root:', merkleRoot);

    // 2. Sagatavo manifest URI un hešu.
    //    Prepare manifest URI and hash.
    // SVARĪGI: Izmanto URI hash, lai atbilstu kontrakta prasībām
    const manifestURI = `ar://${manifestTxId}`;
    const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestURI));
    console.log('   Manifest URI:', manifestURI);
    console.log('   Manifest hash (from URI):', manifestHash);

    // 3. Pārbauda, vai paraksts ir nodots.
    //    Check if signature is provided.
    if (!signature || signature === '0x') {
        throw new Error('Nav paraksta (signature) | No signature provided');
    }
    console.log('   Signature:', signature.substring(0, 30) + '...');

    // 4. Pārbauda, vai nftContract ir nodots.
    //    Check if nftContract is provided.
    if (!nftContract) {
        throw new Error('Nav NFT kontrakta | No NFT contract provided');
    }

    // 5. Izsauc addBackup() ar nodotajiem parametriem.
    //    Call addBackup() with provided parameters.
    console.log('   📤 Calling addBackup()...');
    console.log('   Parameters:');
    console.log('   - tokenId:', tokenId);
    console.log('   - manifestHash:', manifestHash);
    console.log('   - merkleRoot:', merkleRoot);
    console.log('   - manifestURI:', manifestURI);
    console.log('   - deadline:', deadline);
    
    try {
        const tx = await nftContract.addBackup(
            tokenId,
            manifestHash,
            merkleRoot,
            manifestURI,
            deadline,
            signature,
            { gasLimit: 500000 }
        );
        
        console.log('   ✅ Transaction sent:', tx.hash);
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            console.log('   ✅ addBackup successful! Gas used:', receipt.gasUsed.toString());
            console.log('   Block number:', receipt.blockNumber);
        } else {
            throw new Error('addBackup transakcija neizdevās | addBackup transaction failed');
        }
        
        return {
            txHash: tx.hash,
            merkleRoot,
            manifestURI,
            manifestHash,
            receipt
        };
        
    } catch (error) {
        console.error('   ❌ addBackup error:', error.message);
        if (error.receipt) {
            console.error('   Receipt:', {
                status: error.receipt.status,
                gasUsed: error.receipt.gasUsed?.toString(),
                blockNumber: error.receipt.blockNumber
            });
        }
        throw error;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPermRepoSubscription {
    function isSubscribed(address user) external view returns (bool);
}

interface IPermRepoNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title PermRepoRegistry
 *
 * @notice
 * Registry layer connecting:
 * GitHub/GitLab Repository → PermRepo NFT
 *
 * NFT ownership is the only source of repository ownership.
 *
 * Responsibilities:
 * - register repository
 * - map repository -> NFT
 * - verify backup permission
 *
 * Does NOT:
 * - store files
 * - store backups
 * - handle Arweave
 * - handle payments
 */
contract PermRepoRegistry is Ownable2Step, ReentrancyGuard {

    // ==================================================
    // IMMUTABLES
    // ==================================================

    IPermRepoSubscription public immutable subscription;
    IPermRepoNFT public immutable repoNFT;

    // ==================================================
    // STRUCTURES
    // ==================================================

    struct Repository {
        bytes32 repositoryId;
        uint256 nftTokenId;
        uint256 createdAt;
        bool active;
    }

    // ==================================================
    // STORAGE
    // ==================================================

    mapping(bytes32 => Repository) public repositories;
    mapping(uint256 => bytes32) public nftRepository;

    // ==================================================
    // EVENTS
    // ==================================================

    event RepositoryRegistered(bytes32 indexed repositoryId, uint256 indexed nftTokenId);
    event RepositoryDisabled(bytes32 indexed repositoryId);
    event RepositoryUpdated(bytes32 indexed repositoryId);

    // ==================================================
    // ERRORS
    // ==================================================

    error ZeroAddress();
    error RepositoryExists();
    error RepositoryNotFound();
    error InvalidNFT();
    error NotNFTOwner();
    error InvalidRepository();

    // ==================================================
    // CONSTRUCTOR
    // ==================================================

    // Izlabots šeit: Nododam msg.sender kā sākotnējo īpašnieku Ownable bāzes līgumam
    constructor(address subscriptionAddress, address nftAddress) Ownable(msg.sender) {
        if (subscriptionAddress == address(0) || nftAddress == address(0)) {
            revert ZeroAddress();
        }

        subscription = IPermRepoSubscription(subscriptionAddress);
        repoNFT = IPermRepoNFT(nftAddress);
    }

    // ==================================================
    // REGISTER
    // ==================================================

    function registerRepository(bytes32 repositoryId, uint256 nftTokenId) external nonReentrant {
        if (repositoryId == bytes32(0)) revert InvalidRepository();
        if (repositories[repositoryId].active) revert RepositoryExists();
        if (repoNFT.ownerOf(nftTokenId) != msg.sender) revert InvalidNFT();

        repositories[repositoryId] = Repository({
            repositoryId: repositoryId,
            nftTokenId: nftTokenId,
            createdAt: block.timestamp,
            active: true
        });

        nftRepository[nftTokenId] = repositoryId;

        emit RepositoryRegistered(repositoryId, nftTokenId);
    }

    // ==================================================
    // BACKUP PERMISSION CHECK
    // ==================================================

    function canBackup(uint256 nftTokenId) external view returns (bool) {
        bytes32 repositoryId = nftRepository[nftTokenId];
        Repository memory repo = repositories[repositoryId];

        if (!repo.active) return false;

        address owner = repoNFT.ownerOf(nftTokenId);
        return subscription.isSubscribed(owner);
    }

    // ==================================================
    // VERIFY OWNER
    // ==================================================

    function verifyOwnership(uint256 nftTokenId) external view returns (address) {
        return repoNFT.ownerOf(nftTokenId);
    }

    // ==================================================
    // DISABLE
    // ==================================================

    function disableRepository(bytes32 repositoryId) external onlyOwner {
        Repository storage repo = repositories[repositoryId];
        if (!repo.active) revert RepositoryNotFound();
        repo.active = false;
        emit RepositoryDisabled(repositoryId);
    }

    // ==================================================
    // VIEW
    // ==================================================

    function getRepository(bytes32 repositoryId)
        external
        view
        returns (uint256 nftTokenId, uint256 createdAt, bool active)
    {
        Repository memory repo = repositories[repositoryId];
        return (repo.nftTokenId, repo.createdAt, repo.active);
    }

    function getRepositoryByNFT(uint256 nftTokenId) external view returns (bytes32) {
        return nftRepository[nftTokenId];
    }
}

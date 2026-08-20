// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title PermRepoNFT
 *
 * @notice
 * One NFT represents one repository.
 * NFT is only an identity anchor — NOT TRADABLE.
 *
 * Backup data:
 *     Arweave
 *
 * Backup index:
 *     Blockchain events
 *
 * Find backup:
 *     contract address + tokenId + backupNumber
 */
contract PermRepoNFT is ERC721, EIP712, ReentrancyGuard, Ownable2Step {

    // ==================================================
    // CONSTANTS
    // ==================================================

    bytes32 private constant ADD_BACKUP_TYPEHASH =
        keccak256("AddBackup(uint256 tokenId,uint256 backupNumber,bytes32 manifestHash,bytes32 merkleRoot,uint256 deadline,uint256 nonce)");

    bytes32 private constant UPDATE_REPO_HASH_TYPEHASH =
        keccak256("UpdateRepoHash(uint256 tokenId,bytes32 newRepoHash,uint256 nonce,uint256 deadline)");

    // ==================================================
    // STORAGE
    // ==================================================

    uint256 private nextTokenId;

    mapping(uint256 => bytes32) public repositoryHash;
    mapping(bytes32 => uint256) public repositoryTokens;
    mapping(uint256 => uint256) public backupCount;
    mapping(uint256 => uint256) public nonces;
    mapping(uint256 => string) public lastManifestURI;
    mapping(uint256 => bool) internal _isPrivate;

    // ==================================================
    // WEB APP URIs
    // ==================================================

    string public nftAppURI;
    string public subscribeAppURI;
    string public storagePayAppURI;
    string public restoreAppURI;

    // ==================================================
    // EVENTS
    // ==================================================

    event RepositoryMinted(
        uint256 indexed tokenId, 
        address indexed owner, 
        bytes32 indexed repositoryHash,
        bool privateRepo
    );

    event BackupAdded(
        uint256 indexed tokenId, 
        uint256 indexed backupNumber, 
        bytes32 indexed merkleRoot, 
        bytes32 manifestHash, 
        string manifestURI,
        uint256 nonce
    );

    event RepoHashUpdated(
        uint256 indexed tokenId, 
        bytes32 oldRepoHash, 
        bytes32 indexed newRepoHash,
        uint256 nonce
    );

    event NFTAppURIUpdated(string indexed newURI);
    event SubscribeAppURIUpdated(string indexed newURI);
    event StoragePayAppURIUpdated(string indexed newURI);
    event RestoreAppURIUpdated(string indexed newURI);

    // ==================================================
    // ERRORS
    // ==================================================

    error ZeroAddress();
    error RepositoryExists();
    error InvalidToken();
    error InvalidSignature();
    error DeadlineExpired();
    error TransferNotAllowed();

    // ==================================================
    // CONSTRUCTOR
    // ==================================================

    constructor() 
        ERC721("PermRepo", "PREPO") 
        EIP712("PermRepo", "1") 
        Ownable(msg.sender) 
    {}

    // ==================================================
    // TRANSFER RESTRICTION — NFT NAV TIRGOJAMS (Soulbound)
    // ==================================================

    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address) {
        address from = _ownerOf(tokenId);
        
        if (from != address(0) && to != address(0)) {
            revert TransferNotAllowed();
        }

        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public virtual override {
        revert TransferNotAllowed();
    }

    function setApprovalForAll(address, bool) public virtual override {
        revert TransferNotAllowed();
    }

    // ==================================================
    // MINT REPOSITORY NFT
    // ==================================================

    /**
     * @notice Izveido jaunu NFT repozitorijam.
     * @param recipient NFT saņēmēja adrese.
     * @param repository Repozitorija nosaukums (piem., "lietotajs/repo").
     * @param privateRepo Ja true, manifests tiks šifrēts un slēpts.
     * @return tokenId Izveidotā NFT ID.
     */
    function mintRepository(
        address recipient, 
        string calldata repository,
        bool privateRepo
    ) external nonReentrant returns(uint256 tokenId) {
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 repoHash = keccak256(abi.encode(repository));
        if (repositoryTokens[repoHash] != 0) revert RepositoryExists();

        nextTokenId++;
        tokenId = nextTokenId;

        repositoryHash[tokenId] = repoHash;
        repositoryTokens[repoHash] = tokenId;
        _isPrivate[tokenId] = privateRepo;

        _safeMint(recipient, tokenId);

        emit RepositoryMinted(tokenId, recipient, repoHash, privateRepo);
    }

    // ==================================================
    // ADD BACKUP
    // ==================================================

    /**
     * @notice Pievieno jaunu backupa ierakstu NFT.
     * @dev Privātiem NFT manifestURI ir šifrēts (izveidots ārpus līguma).
     * @param tokenId NFT ID.
     * @param manifestHash Manifests hešs.
     * @param merkleRoot Merkle tree sakne.
     * @param manifestURI Arweave manifests URI vai šifrēta vērtība.
     * @param deadline EIP-712 paraksta derīguma termiņš.
     * @param signature EIP-712 paraksts no NFT īpašnieka.
     */
    function addBackup(
        uint256 tokenId, 
        bytes32 manifestHash, 
        bytes32 merkleRoot,
        string calldata manifestURI, 
        uint256 deadline, 
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();

        bytes32 structHash = _hashAddBackup(tokenId, manifestHash, merkleRoot, deadline);

        address owner = ownerOf(tokenId);
        if (owner == address(0)) revert InvalidToken();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != owner) {
            revert InvalidSignature();
        }

        uint256 backupNumber = backupCount[tokenId] + 1;
        uint256 currentNonce = nonces[tokenId];
        
        nonces[tokenId] = currentNonce + 1;
        backupCount[tokenId] = backupNumber;

        lastManifestURI[tokenId] = manifestURI;

        emit BackupAdded(tokenId, backupNumber, merkleRoot, manifestHash, manifestURI, currentNonce);
    }

    // ==================================================
    // UPDATE REPO HASH — mainot repo nosaukumu
    // ==================================================

    /**
     * @notice Atjauno repo hash (ja mainās repo nosaukums).
     * @param tokenId NFT ID.
     * @param newRepoHash Jaunais repo hash.
     * @param deadline EIP-712 paraksta derīguma termiņš.
     * @param signature EIP-712 paraksts no NFT īpašnieka.
     */
    function updateRepoHash(
        uint256 tokenId, 
        bytes32 newRepoHash, 
        uint256 deadline, 
        bytes calldata signature
    ) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (newRepoHash == bytes32(0)) revert ZeroAddress();
        if (repositoryTokens[newRepoHash] != 0) revert RepositoryExists();

        uint256 currentNonce = nonces[tokenId];

        bytes32 structHash = keccak256(abi.encode(
            UPDATE_REPO_HASH_TYPEHASH, 
            tokenId, 
            newRepoHash, 
            currentNonce, 
            deadline
        ));

        address owner = ownerOf(tokenId);
        if (owner == address(0)) revert InvalidToken();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != owner) revert InvalidSignature();

        nonces[tokenId] = currentNonce + 1;

        bytes32 oldRepoHash = repositoryHash[tokenId];
        repositoryHash[tokenId] = newRepoHash;
        delete repositoryTokens[oldRepoHash];
        repositoryTokens[newRepoHash] = tokenId;

        emit RepoHashUpdated(tokenId, oldRepoHash, newRepoHash, currentNonce);
    }

    // ==================================================
    // HELPERS
    // ==================================================

    function _hashAddBackup(
        uint256 tokenId,
        bytes32 manifestHash,
        bytes32 merkleRoot,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            ADD_BACKUP_TYPEHASH,
            tokenId,
            backupCount[tokenId] + 1,
            manifestHash,
            merkleRoot,
            deadline,
            nonces[tokenId]
        ));
    }

    // ==================================================
    // VIEW
    // ==================================================

    /**
     * @notice Atgriež NFT metadata URI (tikai vizuālai informācijai).
     * @dev NEATKLĀJ lastManifestURI — nekādas privātās informācijas.
     * @param tokenId NFT ID.
     * @return JSON metadata ar nosaukumu un aprakstu.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(
            '{"name":"PermRepo NFT #', Strings.toString(tokenId), '",',
            '"description":"Repository backup on Arweave",',
            '"attributes":[{"trait_type":"Backup Count","value":"', Strings.toString(backupCount[tokenId]), '"}]}'
        ));
    }

    /**
     * @notice Atgriež repo hash pēc NFT ID.
     */
    function getRepositoryHash(uint256 tokenId) external view returns(bytes32) {
        return repositoryHash[tokenId];
    }

    /**
     * @notice Atgriež backupu skaitu NFT.
     */
    function getBackupCount(uint256 tokenId) external view returns(uint256) {
        return backupCount[tokenId];
    }

    /**
     * @notice Atgriež nonce vērtību NFT.
     */
    function getNonce(uint256 tokenId) external view returns(uint256) {
        return nonces[tokenId];
    }

    /**
     * @notice Pārbauda, vai NFT ir privāts.
     */
    function isPrivateToken(uint256 tokenId) external view returns(bool) {
        return _isPrivate[tokenId];
    }

    /**
     * @notice Atgriež manifesta URI (šifrētu privātiem, atvērtu publiskiem).
     */
    function getManifestURI(uint256 tokenId) external view returns(string memory) {
        _requireOwned(tokenId);
        return lastManifestURI[tokenId];
    }

    // ==================================================
    // ADMIN: WEB APP URI
    // ==================================================

    /**
     * @notice Uzstāda NFT izveides lapas URI.
     */
    function setNFTAppURI(string calldata uri) external onlyOwner {
        nftAppURI = uri;
        emit NFTAppURIUpdated(uri);
    }

    /**
     * @notice Uzstāda abonementa lapas URI.
     */
    function setSubscribeAppURI(string calldata uri) external onlyOwner {
        subscribeAppURI = uri;
        emit SubscribeAppURIUpdated(uri);
    }

    /**
     * @notice Uzstāda glabāšanas apmaksas lapas URI.
     */
    function setStoragePayAppURI(string calldata uri) external onlyOwner {
        storagePayAppURI = uri;
        emit StoragePayAppURIUpdated(uri);
    }

    /**
     * @notice Uzstāda atjaunošanas lapas URI.
     */
    function setRestoreAppURI(string calldata uri) external onlyOwner {
        restoreAppURI = uri;
        emit RestoreAppURIUpdated(uri);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPermRepoNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title PermRepoSubscription
 * @notice USDC subscription contract — one subscription per NFT (repository)
 */
contract PermRepoSubscription is Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 private constant SUBSCRIPTION_PERIOD = 30 days;
    uint256 private constant MAX_PRICE = 10_000_000; // 10 USDC maximum

    uint256 public subscriptionPrice = 2_000_000; // 2 USDC

    IERC20 public immutable USDC;
    IPermRepoNFT public immutable repoNFT;

    /// @notice tokenId => subscription expiration timestamp
    mapping(uint256 => uint256) public subscriptionExpiry;
    uint256 public totalRevenue;

    event SubscriptionPurchased(uint256 indexed tokenId, uint256 activeUntil, uint256 amount);
    event RevenueWithdrawn(address indexed owner, uint256 amount);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    error ZeroAddress();
    error NotNFTOwner();
    error NothingToWithdraw();
    error InvalidPrice();
    error InvalidTokenId();

    /**
     * @param usdcAddress USDC token address
     * @param nftAddress PermRepoNFT contract address
     */
    constructor(address usdcAddress, address nftAddress) Ownable(msg.sender) {
        if (usdcAddress == address(0)) revert ZeroAddress();
        if (nftAddress == address(0)) revert ZeroAddress();
        
        USDC = IERC20(usdcAddress);
        repoNFT = IPermRepoNFT(nftAddress);
    }

    /**
     * @notice Subscribe for a specific NFT (repository)
     * @param tokenId The NFT token ID representing the repository
     */
    function subscribe(uint256 tokenId) external {
        if (tokenId == 0) revert InvalidTokenId();
        
        address nftOwner = repoNFT.ownerOf(tokenId);
        if (nftOwner != msg.sender) revert NotNFTOwner();

        uint256 price = subscriptionPrice;
        if (price == 0) revert InvalidPrice();

        // 1. CHECKS & EFFECTS (Stāvoklis tiek atjaunots pirms ārējā izsaukuma)
        uint256 currentExpiry = subscriptionExpiry[tokenId];
        uint256 start = currentExpiry > block.timestamp ? currentExpiry : block.timestamp;
        
        subscriptionExpiry[tokenId] = start + SUBSCRIPTION_PERIOD;
        totalRevenue += price;

        emit SubscriptionPurchased(tokenId, subscriptionExpiry[tokenId], price);

        // 2. INTERACTIONS (Drošs ārējais izsaukums)
        USDC.safeTransferFrom(msg.sender, address(this), price);
    }

    /**
     * @notice Check if NFT has active subscription
     * @param tokenId The NFT token ID
     */
    function isSubscribed(uint256 tokenId) external view returns (bool) {
        return subscriptionExpiry[tokenId] > block.timestamp;
    }

    function getSubscriptionExpiry(uint256 tokenId) external view returns (uint256) {
        return subscriptionExpiry[tokenId];
    }

    function withdrawUSDC() external onlyOwner {
        address currentOwner = owner();
        if (currentOwner == address(0)) revert ZeroAddress();

        uint256 balance = USDC.balanceOf(address(this));
        if (balance == 0) revert NothingToWithdraw();
        
        emit RevenueWithdrawn(currentOwner, balance);
        
        USDC.safeTransfer(currentOwner, balance);
    }

    function setPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0 || newPrice > MAX_PRICE) revert InvalidPrice();
        emit PriceUpdated(subscriptionPrice, newPrice);
        subscriptionPrice = newPrice;
    }
}

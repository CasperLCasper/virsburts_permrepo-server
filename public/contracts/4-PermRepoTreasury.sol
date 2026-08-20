// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PermRepoTreasury
 *
 * @notice
 * Treasury līgums PermRepo platformai.
 * Treasury contract for the PermRepo platform.
 *
 * Līguma uzdevums | Contract purpose:
 *
 * 1. Glabāt ETH | Store ETH.
 * 2. Atļaut autorizētam operatoram izmantot līguma ETH,
 *    lai veiktu maksājumus uz jebkuru adresi (ko nosaka serveris).
 *    Allow an authorized operator to use the contract's ETH
 *    to make payments to any address (determined by the server).
 *
 * Operatora privātā atslēga atrodas servera mainīgajā.
 * The operator's private key is stored in the server's environment variable.
 *
 * SVARĪGI | IMPORTANT:
 * Operatora EOA NAV līdzekļu glabātuve.
 * The operator's EOA is NOT a storage of funds.
 * Operatora EOA tikai autorizē contract call.
 * The operator's EOA only authorizes the contract call.
 *
 * Līguma ETH plūsma | Contract ETH flow:
 *
 *     Lietotājs | User
 *         |
 *         | ETH
 *         v
 *     Treasury
 *         |
 *         | payTurbo(destination)
 *         v
 *     Jebkura adrese (ko serveris norāda)
 *     Any address (determined by the server)
 *
 * Operator | Operator:
 *
 *     Server
 *        |
 *        | private key
 *        v
 *     Operator EOA
 *        |
 *        | call payTurbo()
 *        v
 *     Treasury
 */
contract PermRepoTreasury is Ownable2Step, ReentrancyGuard {

    // ============================================================
    // STORAGE | GLABĀŠANA
    // ============================================================

    /**
     * @notice Adrese, kurai atļauts izsaukt payTurbo().
     *         Address authorized to call payTurbo().
     *
     * Šī adrese atbilst servera private key.
     * This address corresponds to the server's private key.
     */
    address public immutable operator;

    // ============================================================
    // EVENTS | NOTIKUMI
    // ============================================================

    /**
     * @notice Emitē, kad lietotājs iemaksā ETH.
     *         Emitted when a user deposits ETH.
     */
    event Deposited(
        address indexed from,
        uint256 amount
    );

    /**
     * @notice Emitē, kad operators veic Turbo maksājumu.
     *         Emitted when the operator makes a Turbo payment.
     */
    event TurboPayment(
        uint256 amount,
        bytes32 indexed paymentId,
        address indexed destination
    );

    /**
     * @notice Emitē ārkārtas izņemšanas gadījumā.
     *         Emitted on emergency withdrawal.
     */
    event EmergencyWithdraw(
        address indexed to,
        uint256 amount
    );

    // ============================================================
    // ERRORS | KĻŪDAS
    // ============================================================

    error ZeroAddress();          // Nulles adrese | Zero address
    error ZeroAmount();           // Nulles summa | Zero amount
    error Unauthorized();         // Nav atļauts | Unauthorized
    error InsufficientBalance();  // Nepietiekama bilance | Insufficient balance
    error PaymentFailed();        // Maksājums neizdevās | Payment failed

    // ============================================================
    // MODIFIERS | MODIFIKATORI
    // ============================================================

    /**
     * @notice Atļauj tikai operatora izsaukumus.
     *         Allows only operator calls.
     */
    modifier onlyOperator() {
        if (msg.sender != operator) {
            revert Unauthorized();
        }

        _;
    }

    // ============================================================
    // CONSTRUCTOR | KONSTRUKTORS
    // ============================================================

    /**
     * @param initialOwner Līguma owner adrese | Contract owner address.
     * @param _operator Servera/operatora EOA adrese | Server/operator EOA address.
     */
    constructor(
        address initialOwner,
        address _operator
    )
        Ownable(initialOwner)
    {
        if (initialOwner == address(0)) {
            revert ZeroAddress();
        }

        if (_operator == address(0)) {
            revert ZeroAddress();
        }

        operator = _operator;
    }

    // ============================================================
    // RECEIVE | SAŅEMŠANA
    // ============================================================

    /**
     * @notice Saņem ETH Treasury līgumā.
     *         Receives ETH into the Treasury contract.
     *
     * ETH var iemaksāt jebkura adrese.
     * ETH can be deposited by any address.
     */
    receive() external payable {
        if (msg.value == 0) {
            revert ZeroAmount();
        }

        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Saņem ETH ar fallback call.
     *         Receives ETH with fallback call.
     */
    fallback() external payable {
        if (msg.value == 0) {
            revert ZeroAmount();
        }

        emit Deposited(msg.sender, msg.value);
    }

    // ============================================================
    // TURBO PAYMENT | TURBO MAKSĀJUMS
    // ============================================================

    /**
     * @notice
     * Nosūta ETH no Treasury uz norādīto adresi.
     * Sends ETH from the Treasury to the specified address.
     *
     * Tikai operatora EOA drīkst izsaukt šo funkciju.
     * Only the operator's EOA may call this function.
     *
     * Destination adrese tiek noteikta SERVERĪ,
     * iegūstot to no Turbo Payment API.
     * The destination address is determined on the SERVER,
     * obtained from the Turbo Payment API.
     *
     * @param amount ETH daudzums wei | ETH amount in wei.
     * @param paymentId Iekšējs payment identifikators | Internal payment identifier.
     * @param destination Saņēmēja adrese | Recipient address.
     */
    function payTurbo(
        uint256 amount,
        bytes32 paymentId,
        address payable destination
    )
        external
        onlyOperator
        nonReentrant
    {
        // Pārbauda summu | Check amount
        if (amount == 0) {
            revert ZeroAmount();
        }

        // Pārbauda adresi | Check address
        if (destination == address(0)) {
            revert ZeroAddress();
        }

        // Pārbauda bilanci | Check balance
        if (address(this).balance < amount) {
            revert InsufficientBalance();
        }

        // Treasury → Destination | No Treasury uz adresi
        (bool success, ) = destination.call{
            value: amount
        }("");

        if (!success) {
            revert PaymentFailed();
        }

        emit TurboPayment(
            amount,
            paymentId,
            destination
        );
    }

    // ============================================================
    // VIEW | SKATĪJUMI
    // ============================================================

    /**
     * @notice Atgriež Treasury ETH bilanci.
     *         Returns the Treasury ETH balance.
     */
    function balance()
        external
        view
        returns (uint256)
    {
        return address(this).balance;
    }

    /**
     * @notice Pārbauda, vai adrese ir operators.
     *         Checks if an address is the operator.
     */
    function isOperator(address account)
        external
        view
        returns (bool)
    {
        return account == operator;
    }

    // ============================================================
    // EMERGENCY | ĀRKĀRTAS GADĪJUMI
    // ============================================================

    /**
     * @notice
     * Ārkārtas līdzekļu izņemšana.
     * Emergency withdrawal of funds.
     *
     * Šī funkcija nav pieejama operatoram.
     * This function is not available to the operator.
     * To var izsaukt tikai contract owner.
     * Only the contract owner can call it.
     */
    function emergencyWithdraw(
        address payable to,
        uint256 amount
    )
        external
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) {
            revert ZeroAddress();
        }

        if (amount == 0) {
            revert ZeroAmount();
        }

        if (address(this).balance < amount) {
            revert InsufficientBalance();
        }

        (bool success, ) = to.call{
            value: amount
        }("");

        if (!success) {
            revert PaymentFailed();
        }

        emit EmergencyWithdraw(
            to,
            amount
        );
    }
}

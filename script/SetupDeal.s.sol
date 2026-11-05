// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "forge-std/Script.sol";
import "../contracts/token/IToken.sol";
import "../contracts/registry/interface/IIdentityRegistry.sol";
import "@onchain-id/solidity/contracts/interface/IIdentity.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../contracts/MockCashToken.sol";
import "../contracts/DVD/DVDTransferManager.sol";

contract SetupDeal is Script {

    // ── Step 8: Whitelist ──────────────────────────────────────────────

    function _step8() internal {
        console.log("=== Step 8: Whitelist ===");

        IIdentityRegistry ir = IIdentityRegistry(vm.envAddress("IR_PROXY"));
        address bndSafe      = vm.envAddress("BND_SAFE");
        address aurora        = vm.envAddress("INVESTOR_AURORA");
        address northbridge   = vm.envAddress("INVESTOR_NORTHBRIDGE");
        address meridian      = vm.envAddress("INVESTOR_MERIDIAN");

        address[] memory w = new address[](4);
        w[0] = bndSafe; w[1] = aurora; w[2] = northbridge; w[3] = meridian;

        IIdentity[] memory ids = new IIdentity[](4);
        ids[0] = IIdentity(bndSafe);
        ids[1] = IIdentity(aurora);
        ids[2] = IIdentity(northbridge);
        ids[3] = IIdentity(meridian);

        uint16[] memory countries = new uint16[](4);

        ir.batchRegisterIdentity(w, ids, countries);
        console.log("Whitelisted 4 addresses");
    }

    // ── Step 9: Mint + Unpause ─────────────────────────────────────────

    function _step9() internal {
        console.log("=== Step 9: Mint + Unpause ===");

        IToken token = IToken(vm.envAddress("TOKEN_PROXY"));
        address bndSafe = vm.envAddress("BND_SAFE");
        uint256 supply  = vm.envOr("SUPPLY_LIMIT", uint256(5000));

        token.mint(bndSafe, supply);
        console.log("Minted bonds to B&D:", supply);

        token.unpause();
        console.log("Token unpaused");
    }

    // ── Step 10: Fund investors with EURd ──────────────────────────────

    function _cashAmounts() internal pure returns (uint256, uint256, uint256) {
        // 500M EUR deal, 100k denomination, 99.9 price, 6 decimals on EURd
        uint256 auroraAmt      = 199_800_000 * 1e6;   // 2000 bonds
        uint256 northbridgeAmt = 174_825_000 * 1e6;    // 1750 bonds
        uint256 meridianAmt    = 124_875_000 * 1e6;    // 1250 bonds
        return (auroraAmt, northbridgeAmt, meridianAmt);
    }

    function _step10() internal {
        console.log("=== Step 10: Fund + Approve ===");

        MockCashToken cash  = MockCashToken(vm.envAddress("MOCK_CASH_TOKEN"));
        address dvdAddr     = vm.envAddress("DVD_MANAGER");
        address aurora      = vm.envAddress("INVESTOR_AURORA");
        address northbridge = vm.envAddress("INVESTOR_NORTHBRIDGE");
        address meridian    = vm.envAddress("INVESTOR_MERIDIAN");

        (uint256 aAmt, uint256 nAmt, uint256 mAmt) = _cashAmounts();

        cash.mint(aurora, aAmt);
        cash.mint(northbridge, nAmt);
        cash.mint(meridian, mAmt);
        console.log("Funded 3 investors with EURd");

        // Approve DVD to pull cash (on testnet, deployer = all wallets)
        cash.approve(dvdAddr, aAmt + nAmt + mAmt);
        console.log("Cash approved for DVD");

        // Approve DVD to pull bonds
        IToken token = IToken(vm.envAddress("TOKEN_PROXY"));
        uint256 supply = vm.envOr("SUPPLY_LIMIT", uint256(5000));
        token.approve(dvdAddr, supply);
        console.log("Bonds approved for DVD");
    }

    // ── Step 11: B&D initiates 3 DVD transfers ─────────────────────────

    function _step11() internal {
        console.log("=== Step 11: Initiate DVD transfers ===");

        DVDTransferManager dvd = DVDTransferManager(vm.envAddress("DVD_MANAGER"));
        address tokenAddr   = vm.envAddress("TOKEN_PROXY");
        address cashAddr    = vm.envAddress("MOCK_CASH_TOKEN");
        address aurora      = vm.envAddress("INVESTOR_AURORA");
        address northbridge = vm.envAddress("INVESTOR_NORTHBRIDGE");
        address meridian    = vm.envAddress("INVESTOR_MERIDIAN");

        (uint256 aAmt, uint256 nAmt, uint256 mAmt) = _cashAmounts();

        dvd.initiateDVDTransfer(tokenAddr, 2000, aurora, cashAddr, aAmt);
        console.log("Trade 1: 2000 bonds -> Aurora");

        dvd.initiateDVDTransfer(tokenAddr, 1750, northbridge, cashAddr, nAmt);
        console.log("Trade 2: 1750 bonds -> Northbridge");

        dvd.initiateDVDTransfer(tokenAddr, 1250, meridian, cashAddr, mAmt);
        console.log("Trade 3: 1250 bonds -> Meridian");
    }

    // ── Step 12: Investors settle (take) transfers ─────────────────────

    function _settle(
        DVDTransferManager dvd,
        uint256 nonce,
        address maker,
        address token1,
        uint256 bondAmt,
        address taker,
        address token2,
        uint256 cashAmt
    ) internal {
        bytes32 tid = dvd.calculateTransferID(nonce, maker, token1, bondAmt, taker, token2, cashAmt);
        dvd.takeDVDTransfer(tid);
    }

    function _step12() internal {
        console.log("=== Step 12: Settle DVD transfers ===");

        DVDTransferManager dvd = DVDTransferManager(vm.envAddress("DVD_MANAGER"));
        address bndSafe   = vm.envAddress("BND_SAFE");
        address tokenAddr = vm.envAddress("TOKEN_PROXY");
        address cashAddr  = vm.envAddress("MOCK_CASH_TOKEN");
        uint256 n = dvd.txNonce() - 3;

        (uint256 aAmt, uint256 nAmt, uint256 mAmt) = _cashAmounts();

        _settle(dvd, n,     bndSafe, tokenAddr, 2000, vm.envAddress("INVESTOR_AURORA"),      cashAddr, aAmt);
        console.log("Settled: Aurora has 2000 bonds");

        _settle(dvd, n + 1, bndSafe, tokenAddr, 1750, vm.envAddress("INVESTOR_NORTHBRIDGE"), cashAddr, nAmt);
        console.log("Settled: Northbridge has 1750 bonds");

        _settle(dvd, n + 2, bndSafe, tokenAddr, 1250, vm.envAddress("INVESTOR_MERIDIAN"),    cashAddr, mAmt);
        console.log("Settled: Meridian has 1250 bonds");
    }

    // ── run() ──────────────────────────────────────────────────────────

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        _step8();
        _step9();
        _step10();
        _step11();
        _step12();

        vm.stopBroadcast();

        IToken token = IToken(vm.envAddress("TOKEN_PROXY"));
        console.log("");
        console.log("========================================");
        console.log("  ALL STEPS COMPLETE");
        console.log("========================================");
        console.log("B&D:        ", token.balanceOf(vm.envAddress("BND_SAFE")));
        console.log("Aurora:     ", token.balanceOf(vm.envAddress("INVESTOR_AURORA")));
        console.log("Northbridge:", token.balanceOf(vm.envAddress("INVESTOR_NORTHBRIDGE")));
        console.log("Meridian:   ", token.balanceOf(vm.envAddress("INVESTOR_MERIDIAN")));
    }
}

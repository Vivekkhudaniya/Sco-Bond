// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "forge-std/Script.sol";

// Implementation contracts (Step 1)
import "../contracts/token/Token.sol";
import "../contracts/registry/implementation/IdentityRegistry.sol";
import "../contracts/registry/implementation/IdentityRegistryStorage.sol";
import "../contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "../contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "../contracts/compliance/modular/ModularCompliance.sol";

// Infrastructure (Steps 2-4)
import "../contracts/proxy/authority/TREXImplementationAuthority.sol";
import "../contracts/proxy/authority/ITREXImplementationAuthority.sol";
import "../contracts/factory/TREXFactory.sol";
import "../contracts/factory/TREXGateway.sol";

// Compliance module (Step 5)
import "../contracts/compliance/modular/modules/SupplyLimitModule.sol";
import "../contracts/compliance/modular/modules/ModuleProxy.sol";

// Cash + DVD (Step 6)
import "../contracts/MockCashToken.sol";
import "../contracts/DVD/DVDTransferManager.sol";

/// @notice Steps 1-6: deploy the shared platform infrastructure (done once)
contract DeployPlatform is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("");

        vm.startBroadcast(deployerKey);

        // ── Step 1: deploy 6 implementation contracts ──
        Token tokenImpl = new Token();
        IdentityRegistry irImpl = new IdentityRegistry();
        IdentityRegistryStorage irsImpl = new IdentityRegistryStorage();
        ClaimTopicsRegistry ctrImpl = new ClaimTopicsRegistry();
        TrustedIssuersRegistry tirImpl = new TrustedIssuersRegistry();
        ModularCompliance mcImpl = new ModularCompliance();

        console.log("=== Step 1: Implementation contracts ===");
        console.log("Token impl:  ", address(tokenImpl));
        console.log("IR impl:     ", address(irImpl));
        console.log("IRS impl:    ", address(irsImpl));
        console.log("CTR impl:    ", address(ctrImpl));
        console.log("TIR impl:    ", address(tirImpl));
        console.log("MC impl:     ", address(mcImpl));
        console.log("");

        // ── Step 2: deploy IA and register implementations ──
        TREXImplementationAuthority ia = new TREXImplementationAuthority(
            true,       // referenceStatus
            address(0), // trexFactory (set later)
            address(0)  // iaFactory (unused)
        );

        ITREXImplementationAuthority.TREXContracts memory contracts = ITREXImplementationAuthority.TREXContracts({
            tokenImplementation: address(tokenImpl),
            ctrImplementation: address(ctrImpl),
            irImplementation: address(irImpl),
            irsImplementation: address(irsImpl),
            tirImplementation: address(tirImpl),
            mcImplementation: address(mcImpl)
        });

        ITREXImplementationAuthority.Version memory version = ITREXImplementationAuthority.Version({
            major: 1,
            minor: 0,
            patch: 0
        });

        ia.addAndUseTREXVersion(version, contracts);

        console.log("=== Step 2: ImplementationAuthority ===");
        console.log("IA:          ", address(ia));
        console.log("");

        // ── Step 3: deploy TREXFactory (our modified version, no idFactory) ──
        TREXFactory factory = new TREXFactory(address(ia));

        console.log("=== Step 3: TREXFactory ===");
        console.log("Factory:     ", address(factory));
        console.log("");

        // ── Step 4: deploy TREXGateway, wire it, approve deployer ──
        TREXGateway gateway = new TREXGateway(address(factory), false);

        factory.transferOwnership(address(gateway));
        gateway.addDeployer(deployer);

        console.log("=== Step 4: TREXGateway ===");
        console.log("Gateway:     ", address(gateway));
        console.log("Factory owner transferred to Gateway");
        console.log("Deployer approved:", deployer);
        console.log("");

        // ── Step 5: deploy SupplyLimitModule behind ModuleProxy ──
        SupplyLimitModule slImpl = new SupplyLimitModule();
        ModuleProxy slProxy = new ModuleProxy(address(slImpl), "");
        SupplyLimitModule(address(slProxy)).initialize();

        console.log("=== Step 5: SupplyLimitModule ===");
        console.log("SL impl:     ", address(slImpl));
        console.log("SL proxy:    ", address(slProxy));
        console.log("");

        // ── Step 6: deploy MockCashToken and DVDTransferManager ──
        MockCashToken cash = new MockCashToken();
        DVDTransferManager dvd = new DVDTransferManager();

        console.log("=== Step 6: Cash + DVD ===");
        console.log("MockCashToken:", address(cash));
        console.log("DVD Manager:  ", address(dvd));
        console.log("");

        vm.stopBroadcast();

        // ── Print summary for .env ──
        console.log("========================================");
        console.log("  SAVE THESE ADDRESSES TO .env");
        console.log("========================================");
        console.log("IA=%s", vm.toString(address(ia)));
        console.log("FACTORY=%s", vm.toString(address(factory)));
        console.log("GATEWAY=%s", vm.toString(address(gateway)));
        console.log("SUPPLY_LIMIT_MODULE=%s", vm.toString(address(slProxy)));
        console.log("MOCK_CASH_TOKEN=%s", vm.toString(address(cash)));
        console.log("DVD_MANAGER=%s", vm.toString(address(dvd)));
    }
}

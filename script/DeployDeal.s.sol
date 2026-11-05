// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "forge-std/Script.sol";
import "../contracts/factory/TREXGateway.sol";
import "../contracts/factory/ITREXFactory.sol";
import "../contracts/compliance/modular/modules/SupplyLimitModule.sol";

/// @notice Step 7: deploy a deal via gateway.deployTREXSuite(...)
contract DeployDeal is Script {
    function _buildTokenDetails()
        internal
        view
        returns (ITREXFactory.TokenDetails memory)
    {
        address supplyLimitModule = vm.envAddress("SUPPLY_LIMIT_MODULE");
        address platformAdmin = vm.envAddress("PLATFORM_ADMIN");
        address registrarSafe = vm.envAddress("REGISTRAR_SAFE");
        address bndSafe = vm.envAddress("BND_SAFE");
        uint256 supplyLimit = vm.envOr("SUPPLY_LIMIT", uint256(5000));

        address[] memory irAgents = new address[](1);
        irAgents[0] = registrarSafe;

        address[] memory tokenAgents = new address[](1);
        tokenAgents[0] = bndSafe;

        address[] memory complianceModules = new address[](1);
        complianceModules[0] = supplyLimitModule;

        bytes[] memory complianceSettings = new bytes[](1);
        complianceSettings[0] = abi.encodeWithSelector(
            SupplyLimitModule.setSupplyLimit.selector,
            supplyLimit
        );

        return ITREXFactory.TokenDetails({
            owner: platformAdmin,
            name: vm.envOr("TOKEN_NAME", string("ACME Corp / 3.875% Fixed EMTN")),
            symbol: vm.envOr("TOKEN_SYMBOL", string("TR-51X5RT-01")),
            decimals: 0,
            irs: address(0),
            ONCHAINID: address(0),
            irAgents: irAgents,
            tokenAgents: tokenAgents,
            complianceModules: complianceModules,
            complianceSettings: complianceSettings
        });
    }

    function _buildClaimDetails()
        internal
        pure
        returns (ITREXFactory.ClaimDetails memory)
    {
        return ITREXFactory.ClaimDetails({
            claimTopics: new uint256[](0),
            issuers: new address[](0),
            issuerClaims: new uint256[][](0)
        });
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gatewayAddr = vm.envAddress("GATEWAY");

        ITREXFactory.TokenDetails memory td = _buildTokenDetails();
        ITREXFactory.ClaimDetails memory cd = _buildClaimDetails();

        console.log("=== Step 7: Deploy Deal ===");
        console.log("Gateway:", gatewayAddr);
        console.log("Owner:  ", td.owner);

        vm.startBroadcast(deployerKey);
        TREXGateway(gatewayAddr).deployTREXSuite(td, cd);
        vm.stopBroadcast();

        console.log("");
        console.log("Deal deployed!");
        console.log("Find TOKEN_PROXY and IR_PROXY in the TREXSuiteDeployed event logs.");
        console.log("Set them in .env before running SetupDeal.");
    }
}

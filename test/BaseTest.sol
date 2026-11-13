// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "forge-std/Test.sol";

import "../contracts/token/Token.sol";
import "../contracts/token/IToken.sol";
import "../contracts/registry/implementation/IdentityRegistry.sol";
import "../contracts/registry/implementation/IdentityRegistryStorage.sol";
import "../contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "../contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "../contracts/compliance/modular/ModularCompliance.sol";
import "../contracts/compliance/modular/IModularCompliance.sol";
import "../contracts/proxy/authority/TREXImplementationAuthority.sol";
import "../contracts/proxy/authority/ITREXImplementationAuthority.sol";
import "../contracts/factory/TREXFactory.sol";
import "../contracts/factory/ITREXFactory.sol";
import "../contracts/factory/TREXGateway.sol";
import "../contracts/compliance/modular/modules/SupplyLimitModule.sol";
import "../contracts/compliance/modular/modules/ModuleProxy.sol";
import "../contracts/MockCashToken.sol";
import "../contracts/DVD/DVDTransferManager.sol";
import "../contracts/registry/interface/IIdentityRegistry.sol";
import "../contracts/registry/interface/IIdentityRegistryStorage.sol";
import "../contracts/registry/interface/IClaimTopicsRegistry.sol";
import "../contracts/registry/interface/ITrustedIssuersRegistry.sol";
import "../contracts/roles/AgentRole.sol";
import "@onchain-id/solidity/contracts/interface/IIdentity.sol";

contract BaseTest is Test {

    // ── platform infra ──
    TREXImplementationAuthority public ia;
    TREXFactory public factory;
    TREXGateway public gateway;
    SupplyLimitModule public supplyLimitModule;
    MockCashToken public cashToken;
    DVDTransferManager public dvdManager;

    // ── test wallets ──
    address public deployer;
    address public platformAdmin;
    address public registrar;
    address public bndSafe;
    address public aurora;
    address public northbridge;
    address public meridian;
    address public outsider;

    uint256 public constant SUPPLY_LIMIT = 5000;

    function setUp() public virtual {
        deployer      = address(this);
        platformAdmin = makeAddr("platformAdmin");
        registrar     = makeAddr("registrar");
        bndSafe       = makeAddr("bndSafe");
        aurora        = makeAddr("aurora");
        northbridge   = makeAddr("northbridge");
        meridian      = makeAddr("meridian");
        outsider      = makeAddr("outsider");

        // Step 1: deploy 6 implementations
        Token tokenImpl = new Token();
        IdentityRegistry irImpl = new IdentityRegistry();
        IdentityRegistryStorage irsImpl = new IdentityRegistryStorage();
        ClaimTopicsRegistry ctrImpl = new ClaimTopicsRegistry();
        TrustedIssuersRegistry tirImpl = new TrustedIssuersRegistry();
        ModularCompliance mcImpl = new ModularCompliance();

        // Step 2: deploy IA + register version
        ia = new TREXImplementationAuthority(true, address(0), address(0));

        ITREXImplementationAuthority.TREXContracts memory impls = ITREXImplementationAuthority.TREXContracts({
            tokenImplementation: address(tokenImpl),
            ctrImplementation: address(ctrImpl),
            irImplementation: address(irImpl),
            irsImplementation: address(irsImpl),
            tirImplementation: address(tirImpl),
            mcImplementation: address(mcImpl)
        });

        ITREXImplementationAuthority.Version memory v = ITREXImplementationAuthority.Version({
            major: 1, minor: 0, patch: 0
        });

        ia.addAndUseTREXVersion(v, impls);

        // Step 3: deploy factory
        factory = new TREXFactory(address(ia));

        // Step 4: deploy gateway, wire ownership, add deployer
        gateway = new TREXGateway(address(factory), false);
        factory.transferOwnership(address(gateway));
        gateway.addDeployer(deployer);

        // Step 5: deploy SupplyLimitModule behind proxy
        SupplyLimitModule slImpl = new SupplyLimitModule();
        ModuleProxy slProxy = new ModuleProxy(address(slImpl), "");
        SupplyLimitModule(address(slProxy)).initialize();
        supplyLimitModule = SupplyLimitModule(address(slProxy));

        // Step 6: deploy cash + DVD
        cashToken = new MockCashToken();
        dvdManager = new DVDTransferManager();
    }

    // ── helpers ──

    struct DealAddresses {
        address token;
        address ir;
        address irs;
        address tir;
        address ctr;
        address mc;
    }

    function _deployDeal() internal returns (DealAddresses memory deal) {
        return _deployDealAs(deployer, platformAdmin);
    }

    function _deployDealAs(address caller, address owner) internal returns (DealAddresses memory deal) {
        ITREXFactory.TokenDetails memory td = _defaultTokenDetails(owner);
        ITREXFactory.ClaimDetails memory cd = _defaultClaimDetails();

        vm.recordLogs();
        vm.prank(caller);
        gateway.deployTREXSuite(td, cd);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        deal = _parseSuiteDeployed(logs);
    }

    function _defaultTokenDetails(address owner) internal view returns (ITREXFactory.TokenDetails memory) {
        address[] memory irAgents = new address[](1);
        irAgents[0] = registrar;

        address[] memory tokenAgents = new address[](1);
        tokenAgents[0] = bndSafe;

        address[] memory complianceModules = new address[](1);
        complianceModules[0] = address(supplyLimitModule);

        bytes[] memory complianceSettings = new bytes[](1);
        complianceSettings[0] = abi.encodeWithSelector(
            SupplyLimitModule.setSupplyLimit.selector,
            SUPPLY_LIMIT
        );

        return ITREXFactory.TokenDetails({
            owner: owner,
            name: "ACME Corp / 3.875% Fixed EMTN",
            symbol: "TR-51X5RT-01",
            decimals: 0,
            irs: address(0),
            ONCHAINID: address(0),
            irAgents: irAgents,
            tokenAgents: tokenAgents,
            complianceModules: complianceModules,
            complianceSettings: complianceSettings
        });
    }

    function _defaultClaimDetails() internal pure returns (ITREXFactory.ClaimDetails memory) {
        return ITREXFactory.ClaimDetails({
            claimTopics: new uint256[](0),
            issuers: new address[](0),
            issuerClaims: new uint256[][](0)
        });
    }

    function _parseSuiteDeployed(Vm.Log[] memory logs) internal pure returns (DealAddresses memory deal) {
        // TREXSuiteDeployed(address indexed _token, address _ir, address _irs, address _tir, address _ctr, address _mc, string indexed _salt)
        bytes32 eventSig = keccak256("TREXSuiteDeployed(address,address,address,address,address,address,string)");

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == eventSig) {
                deal.token = address(uint160(uint256(logs[i].topics[1])));
                (deal.ir, deal.irs, deal.tir, deal.ctr, deal.mc) =
                    abi.decode(logs[i].data, (address, address, address, address, address));
                return deal;
            }
        }
        revert("TREXSuiteDeployed event not found");
    }
}

// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "./BaseTest.sol";

contract Phase1_Factory is BaseTest {

    DealAddresses d;

    function setUp() public override {
        super.setUp();
        d = _deployDeal();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  1.1 TREXFactory — deployTREXSuite
    // ═══════════════════════════════════════════════════════════════════

    function test_deployTREXSuite_deploys6Proxies() public view {
        assertTrue(d.token != address(0), "token is zero");
        assertTrue(d.ir    != address(0), "ir is zero");
        assertTrue(d.irs   != address(0), "irs is zero");
        assertTrue(d.tir   != address(0), "tir is zero");
        assertTrue(d.ctr   != address(0), "ctr is zero");
        assertTrue(d.mc    != address(0), "mc is zero");

        // all unique
        assertTrue(d.token != d.ir,  "token == ir");
        assertTrue(d.token != d.irs, "token == irs");
        assertTrue(d.token != d.tir, "token == tir");
        assertTrue(d.token != d.ctr, "token == ctr");
        assertTrue(d.token != d.mc,  "token == mc");
        assertTrue(d.ir    != d.irs, "ir == irs");
    }

    function test_deployTREXSuite_setsOwnership() public view {
        assertEq(Ownable(d.token).owner(), platformAdmin, "token owner");
        assertEq(Ownable(d.ir).owner(),    platformAdmin, "ir owner");
        assertEq(Ownable(d.tir).owner(),   platformAdmin, "tir owner");
        assertEq(Ownable(d.ctr).owner(),   platformAdmin, "ctr owner");
        assertEq(Ownable(d.mc).owner(),    platformAdmin, "mc owner");
    }

    function test_deployTREXSuite_registersIRAgent() public view {
        assertTrue(
            AgentRole(d.ir).isAgent(registrar),
            "registrar not IR agent"
        );
    }

    function test_deployTREXSuite_registersTokenAgent() public view {
        assertTrue(
            AgentRole(d.token).isAgent(bndSafe),
            "bndSafe not token agent"
        );
    }

    function test_deployTREXSuite_bindsComplianceModule() public view {
        IModularCompliance mc = IModularCompliance(d.mc);
        assertTrue(
            mc.isModuleBound(address(supplyLimitModule)),
            "supply limit module not bound"
        );
    }

    function test_deployTREXSuite_supplyLimitIsSet() public view {
        IModularCompliance mc = IModularCompliance(d.mc);
        uint256 limit = supplyLimitModule.getSupplyLimit(address(mc));
        assertEq(limit, SUPPLY_LIMIT, "supply limit mismatch");
    }

    function test_deployTREXSuite_bindsIRStoIR() public view {
        IIdentityRegistryStorage irs = IIdentityRegistryStorage(d.irs);
        address[] memory linked = irs.linkedIdentityRegistries();
        bool found = false;
        for (uint256 i = 0; i < linked.length; i++) {
            if (linked[i] == d.ir) { found = true; break; }
        }
        assertTrue(found, "IRS not linked to IR");
    }

    function test_deployTREXSuite_tokenIsIRAgent() public view {
        assertTrue(
            AgentRole(d.ir).isAgent(d.token),
            "Token not registered as IR agent"
        );
    }

    function test_deployTREXSuite_onchainIDIsZero() public view {
        assertEq(
            IToken(d.token).onchainID(),
            address(0),
            "onchainID should be zero"
        );
    }

    function test_deployTREXSuite_emptyClaimTopics() public view {
        IClaimTopicsRegistry ctr = IClaimTopicsRegistry(d.ctr);
        uint256[] memory topics = ctr.getClaimTopics();
        assertEq(topics.length, 0, "claim topics should be empty");
    }

    function test_deployTREXSuite_emptyTrustedIssuers() public view {
        ITrustedIssuersRegistry tir = ITrustedIssuersRegistry(d.tir);
        IClaimIssuer[] memory issuers = tir.getTrustedIssuers();
        assertEq(issuers.length, 0, "trusted issuers should be empty");
    }

    function test_deployTREXSuite_tokenStartsPaused() public view {
        assertTrue(
            IToken(d.token).paused(),
            "token should start paused"
        );
    }

    function test_deployTREXSuite_tokenMetadata() public view {
        IToken token = IToken(d.token);
        assertEq(token.name(),     "ACME Corp / 3.875% Fixed EMTN");
        assertEq(token.symbol(),   "TR-51X5RT-01");
        assertEq(token.decimals(), 0);
    }

    function test_deployTREXSuite_duplicateSaltReverts() public {
        ITREXFactory.TokenDetails memory td = _defaultTokenDetails(platformAdmin);
        ITREXFactory.ClaimDetails memory cd = _defaultClaimDetails();

        vm.expectRevert();
        vm.prank(deployer);
        gateway.deployTREXSuite(td, cd);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  1.2 TREXGateway — access control
    // ═══════════════════════════════════════════════════════════════════

    function test_gateway_onlyApprovedDeployerCanDeploy() public {
        ITREXFactory.TokenDetails memory td = _defaultTokenDetails(outsider);
        td.name = "Outsider Bond";
        ITREXFactory.ClaimDetails memory cd = _defaultClaimDetails();

        vm.expectRevert(PublicDeploymentsNotAllowed.selector);
        vm.prank(outsider);
        gateway.deployTREXSuite(td, cd);
    }

    function test_gateway_addRemoveDeployer() public {
        gateway.addDeployer(outsider);
        assertTrue(gateway.isDeployer(outsider), "should be deployer");

        gateway.removeDeployer(outsider);
        assertFalse(gateway.isDeployer(outsider), "should not be deployer");
    }

    function test_gateway_ownerCanAlwaysDeploy() public {
        // deployer (address(this)) is gateway owner AND approved deployer
        // deploy a second deal with different name
        ITREXFactory.TokenDetails memory td = _defaultTokenDetails(platformAdmin);
        td.name = "Second Bond";
        ITREXFactory.ClaimDetails memory cd = _defaultClaimDetails();

        // should succeed without revert
        gateway.deployTREXSuite(td, cd);
    }

    function test_gateway_publicDeploymentMode() public {
        gateway.setPublicDeploymentStatus(true);

        ITREXFactory.TokenDetails memory td = _defaultTokenDetails(outsider);
        td.name = "Public Bond";
        ITREXFactory.ClaimDetails memory cd = _defaultClaimDetails();

        vm.prank(outsider);
        gateway.deployTREXSuite(td, cd);
        // no revert = success
    }

    // ═══════════════════════════════════════════════════════════════════
    //  1.3 TREXFactory — ONCHAINID removal
    // ═══════════════════════════════════════════════════════════════════

    function test_factory_constructorTakesOneParam() public view {
        assertEq(
            factory.getImplementationAuthority(),
            address(ia),
            "IA not set"
        );
    }

    function test_factory_noIdFactoryStorage() public {
        // getIdFactory() should not exist on our modified factory
        (bool success,) = address(factory).staticcall(
            abi.encodeWithSignature("getIdFactory()")
        );
        assertFalse(success, "getIdFactory should not exist");
    }

    function test_factory_zeroONCHAINID_noIdentityCreated() public view {
        address tokenOID = IToken(d.token).onchainID();
        assertEq(tokenOID, address(0), "onchainID should be zero");
        // no code at address(0)
        uint256 codeSize;
        assembly { codeSize := extcodesize(tokenOID) }
        assertEq(codeSize, 0, "no identity contract should be deployed");
    }
}

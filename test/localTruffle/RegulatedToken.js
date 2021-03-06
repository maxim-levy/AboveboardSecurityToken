const BigNumber = require('bignumber.js')

const helpers = require('../helpers/throwAndAssert')
const RegulatedToken = artifacts.require('./RegulatedToken.sol')
const RegulatorService = artifacts.require('./RegulatorService.sol')
const IssuanceWhiteList = artifacts.require('./IssuanceWhiteList.sol')
const SecureIssuanceWhiteList = artifacts.require('contracts/SecureIssuanceWhiteList.sol')
const SettingsStorage = artifacts.require('./SettingsStorage.sol')

contract('RegulatedToken', async accounts => {
  let storage
  let regulator
  let token
  let whitelist
  let secureWhitelist
  let regDWhitelist
  let releaseTime

  const owner = accounts[0]
  const receiver = accounts[1]
  const issuer = accounts[4]
  const newOwner = accounts[5]

  const fromOwner = { from: owner }
  const fromReceiver = { from: receiver }
  const fromNewOwner = { from: newOwner }

  beforeEach(async () => {
    releaseTime = web3.eth.getBlock('latest').timestamp + helpers.duration.years(1)

    storage = await SettingsStorage.new(false, true, 0, { from: owner })

    regulator = await RegulatorService.new(storage.address, { from: owner })

    token = await RegulatedToken.new(regulator.address, 'Test', 'TEST', 0)

    whitelist = await IssuanceWhiteList.new('Affiliates', { from: owner })

    secureWhitelist = await SecureIssuanceWhiteList.new('qib', { from: owner })

    regDWhitelist = await IssuanceWhiteList.new('RegD', { from: owner })

    await secureWhitelist.addToken(storage.address)

    await storage.setIssuerPermission('setLocked', true)
    await storage.setIssuerPermission('setInititalOfferEndDate', true)
    await storage.setIssuerPermission('allowNewShareholders', true)
    await storage.setIssuerPermission('addWhitelist', true)

    await storage.addOfficer(issuer)
    await storage.allowNewShareholders(true, { from: issuer })
    await storage.addWhitelist(whitelist.address)
    await storage.addWhitelist(secureWhitelist.address)
    await storage.addWhitelist(regDWhitelist.address)
    await storage.setInititalOfferEndDate(releaseTime, { from: issuer })

    // mint
    await token.mint(owner, 100, fromOwner)

    // transfer ownership to new owner
    await token.transferOwnership(newOwner)
    await regulator.transferOwnership(newOwner)

    await token.mint(newOwner, 100, fromNewOwner)
    await token.finishMinting(fromNewOwner)

    await assertBalances({ owner: 100, receiver: 0 })
    await assertBalancesNewOwner({ newOwner: 100, receiver: 0 })
  })

  const assertBalances = async balances => {
    assert.equal(balances.owner, (await token.balanceOf.call(owner)).valueOf())
    assert.equal(balances.receiver, (await token.balanceOf.call(receiver)).valueOf())
  }

  const assertBalancesNewOwner = async balances => {
    assert.equal(balances.newOwner, (await token.balanceOf.call(newOwner)).valueOf())
    assert.equal(balances.receiver, (await token.balanceOf.call(receiver)).valueOf())
  }

  const assertCheckStatusEvent = async (event, params) => {
    const p = Object.assign({}, params, {
      reason: new BigNumber(params.reason),
      value: new BigNumber(params.value)
    })

    return helpers.assertEvent(event, p, (expected, actual) => {
      assert.equal(expected.reason.valueOf(), actual.reason.valueOf())
      assert.equal(expected.spender, actual.spender)
      assert.equal(expected.from, actual.from)
      assert.equal(expected.to, actual.to)
      assert.equal(expected.value.valueOf(), actual.value.valueOf())
    })
  }

  describe('constructor', () => {
    it('requires a non-zero registry argument', async () => {
      await helpers.expectThrow(RegulatedToken.new(0, 'TEST', 'Test', 0))
    })
  })

  describe('transfer', () => {
    describe('when the receiver is not added to whitelist', () => {
      beforeEach(async () => {
        await assertBalances({ owner: 100, receiver: 0 })
      })

      it('triggers a CheckStatus event and does NOT transfer funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 100, receiver: 0 })
        await assertCheckStatusEvent(event, {
          reason: 4,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })
      })
    })

    describe('when receiver is added to whitelist', () => {
      beforeEach(async () => {
        await whitelist.add(receiver, '', 0, '', '')
        await assertBalances({ owner: 100, receiver: 0 })
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 75, receiver: value })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })
      })
    })

    describe('when new shareholders are not allowed', () => {
      beforeEach(async () => {
        await whitelist.add(receiver, '', 0, '', '')
        await whitelist.add(accounts[2], '', 0, '', '')
        await assertBalances({ owner: 100, receiver: 0 })
      })

      it('triggers a CheckStatus event and does NOT transfers funds', async () => {
        // disable new shareholders
        await storage.allowNewShareholders(false, { from: issuer })
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 100, receiver: 0 })
        await assertCheckStatusEvent(event, {
          reason: 2,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        var event = token.CheckStatus()
        const value = 25

        // transfer funds to receiver, so balance is not zero
        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 75, receiver: value })

        // disable new shareholders
        await storage.allowNewShareholders(false, { from: issuer })

        event = token.CheckStatus()
        // transfer will pass to existing shareholder, receiver already has funds
        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 50, receiver: 50 })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })

        event = token.CheckStatus()
        // transfer will fail to new shareholder
        await token.transfer(accounts[2], value, fromOwner)
        await assertCheckStatusEvent(event, {
          reason: 2,
          spender: owner,
          from: owner,
          to: accounts[2],
          value
        })
      })
    })

    describe('when receiver is under Regulation D, transfer is before release date', () => {
      beforeEach(async () => {
        await regDWhitelist.add(receiver, '', 0, '', '')
        await assertBalances({ owner: 100, receiver: 0 })
      })

      it('triggers a CheckStatus event and does NOT transfer funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 100, receiver: 0 })
        await assertCheckStatusEvent(event, {
          reason: 5,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })
      })
    })

    describe('when receiver is under Regulation D, transfer is after release date', () => {
      beforeEach(async () => {
        await regDWhitelist.add(receiver, '', 0, '', '')
        await assertBalances({ owner: 100, receiver: 0 })
        await helpers.increaseTimeTo(releaseTime + helpers.duration.seconds(100), web3)
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromOwner)
        await assertBalances({ owner: 75, receiver: value })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: owner,
          from: owner,
          to: receiver,
          value
        })
      })
    })

    describe('when receiver is under Regulation D, only token contract owner can send to US investors first year', () => {
      beforeEach(async () => {
        await regDWhitelist.add(receiver, '', 0, '', '')
        await storage.addOfficer(owner, { from: issuer })
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 75, receiver: value })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: newOwner,
          from: newOwner,
          to: receiver,
          value
        })
      })
    })

    describe('when receiver is under Regulation D, cannot sell these shares in the first year, except to the token contract owner', () => {
      beforeEach(async () => {
        await regDWhitelist.add(receiver, '', 0, '', '')
        await storage.addOfficer(owner, { from: issuer })
      })

      it('triggers a CheckStatus event, transfers funds from issuer then transfers funds back to token contract owner', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 75, receiver: value })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: newOwner,
          from: newOwner,
          to: receiver,
          value
        })

        const ev = token.CheckStatus()
        await token.transfer(newOwner, value, fromReceiver)
        await assertBalancesNewOwner({ newOwner: 100, receiver: 0 })
        await assertCheckStatusEvent(ev, {
          reason: 0,
          spender: receiver,
          from: receiver,
          to: newOwner,
          value
        })
      })

      it('triggers a CheckStatus event, transfers funds from token contract owner then transfers funds back to token contract owner even when trading is locked', async () => {
        const event = token.CheckStatus()
        const value = 25

        await token.transfer(receiver, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 75, receiver: value })
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: newOwner,
          from: newOwner,
          to: receiver,
          value
        })

        // lock trading. Trading will pass because we are sending back to token contract owner
        await storage.setLocked(true)

        const ev = token.CheckStatus()
        await token.transfer(newOwner, value, fromReceiver)
        await assertBalancesNewOwner({ newOwner: 100, receiver: 0 })
        await assertCheckStatusEvent(ev, {
          reason: 0,
          spender: receiver,
          from: receiver,
          to: newOwner,
          value
        })
      })
    })

    describe('when sender is on secure whitelist and receiver is on Reg D whitelist', () => {
      beforeEach(async () => {
        await secureWhitelist.add(accounts[6], '', 0, '', '')
        await regDWhitelist.add(accounts[7], '', 0, '', '')
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        const event = token.CheckStatus()
        const value = 25

        // transfer some funds
        await token.transfer(accounts[6], value, fromNewOwner)
        await assertCheckStatusEvent(event, {
          reason: 0,
          spender: newOwner,
          from: newOwner,
          to: accounts[6],
          value
        })

        // transfer from receiver. Receiver is on QIB whitelist
        const ev = token.CheckStatus()
        await token.transfer(accounts[7], value, { from: accounts[6] })
        await assertCheckStatusEvent(ev, {
          reason: 0,
          spender: accounts[6],
          from: accounts[6],
          to: accounts[7],
          value
        })
      })
    })
  })

  describe('transferFrom', () => {
    describe('when receiver is added to whitelist', () => {
      beforeEach(async () => {
        await whitelist.add(receiver, '', 0, '', '')
      })

      it('triggers a CheckStatus event and transfers funds', async () => {
        const value = 25

        await token.transfer(receiver, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 75, receiver: value })

        await token.approve(receiver, value, { from: receiver })

        await token.transferFrom(receiver, newOwner, value, fromReceiver)
        await assertBalancesNewOwner({ newOwner: 100, receiver: 0 })
      })
    })
  })

  describe('arbitrage', () => {
    describe('when receiver is added to whitelist', () => {
      beforeEach(async () => {
        await whitelist.add(receiver, '', 0, '', '')
      })

      it('transfers funds back to owner', async () => {
        const value = 25

        await token.transfer(receiver, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 75, receiver: value })

        await token.arbitrage(receiver, newOwner, value, fromNewOwner)
        await assertBalancesNewOwner({ newOwner: 100, receiver: 0 })
      })
    })
  })
})

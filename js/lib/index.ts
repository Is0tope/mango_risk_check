import { BN, Cluster, MangoAccount, MangoClient, MangoGroup, PerpMarket, PerpMarketConfig, uiToNative } from '@blockworks-foundation/mango-client'
import { PublicKey, Keypair, SystemProgram, Connection, ConfirmOptions, TransactionInstruction, Transaction } from '@solana/web3.js'
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import IDL from '../idl.json'
import { findProgramAddressSync } from '@project-serum/anchor/dist/cjs/utils/pubkey'
import { TypeDef } from '@project-serum/anchor/dist/cjs/program/namespace/types'
import { IdlTypeDef } from '@project-serum/anchor/dist/cjs/idl'

const RISK_PARAMS_ACCOUNT_SEED_PHRASE = 'risk-check'
const DEFAULT_PROGRAM_ID = new PublicKey('94oHQMrCECP266YUoQmDvgVwafZApP9KAseMyNtjAPP7')

export enum ViolationBehaviour {
    RejectTransaction = 0,
    CancelAllOrders = 1
}

interface NewMangoRiskCheckArgs {
    owner: Keypair
    connection: Connection
    mangoAccount: MangoAccount
    mangoGroup: MangoGroup
    mangoClient: MangoClient
    programID?: PublicKey
}

export class MangoRiskCheck {
    private _programID: PublicKey
    private _connection: Connection
    private _owner: Keypair
    private _program: Program
    private _mangoGroup: MangoGroup
    private _mangoAccount: MangoAccount
    private _mangoClient: MangoClient
    private _riskAccountCache: Map<number,PublicKey> = new Map()
    private _violationBehaviourEnumMap: Map<ViolationBehaviour,any> = new Map()

    constructor(args: NewMangoRiskCheckArgs) {
        const { programID, connection, mangoAccount, mangoGroup, mangoClient } = args

        this._owner = args.owner
        this._connection = connection
        this._mangoAccount = mangoAccount
        this._mangoGroup = mangoGroup
        this._mangoClient = mangoClient
        this._programID = DEFAULT_PROGRAM_ID

        if(programID) {
            this._programID = programID
        }

        // TODO: This is a hack, as unsure how to use enums with Anchor's IDL
        this._violationBehaviourEnumMap.set(ViolationBehaviour.RejectTransaction,{ rejectTransaction: {}})
        this._violationBehaviourEnumMap.set(ViolationBehaviour.CancelAllOrders,{ cancelAllOrders: {}})

        // TODO: What about the confirmation options? Probably should pass these in somehow
        const provider = new anchor.Provider(this._connection,new anchor.Wallet(this._owner),{})
        this._program = new Program(IDL as anchor.Idl,this._programID,provider)
    }

    mapViolationBehaviour(violationBehaviour: ViolationBehaviour): any {
        return this._violationBehaviourEnumMap.get(violationBehaviour)
    }

    uiToNativeQuantity(perpMarket: PerpMarket, quantity: number): BN {
        const [_,nativeQuantity] = perpMarket.uiToNativePriceQuantity(0,quantity)
        return nativeQuantity
      }

    deriveRiskAccountAddress(marketIndex: number): [PublicKey,number] {
        return findProgramAddressSync(
            [
              anchor.utils.bytes.utf8.encode(RISK_PARAMS_ACCOUNT_SEED_PHRASE),
              new Uint8Array([marketIndex]),
              this._owner.publicKey.toBuffer()
            ],
            this._programID
        )
    }

    getRiskAccountAddress(perpMarketConfig: PerpMarketConfig): PublicKey {
        const marketIndex = perpMarketConfig.marketIndex
        if(!this._riskAccountCache.has(marketIndex)) {
            const [address,_] = this.deriveRiskAccountAddress(perpMarketConfig.marketIndex)
            this._riskAccountCache.set(marketIndex,address)
        }
        return this._riskAccountCache.get(marketIndex)!
    }

    makeInitializeInstruction(perpMarketConfig: PerpMarketConfig): TransactionInstruction {
        const marketIndex = perpMarketConfig.marketIndex
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.initialize(marketIndex,{
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                systemProgram: SystemProgram.programId
            }
        })
    }

    async initializeRiskAccount(perpMarketConfig: PerpMarketConfig): Promise<string> {
        const ix = this.makeInitializeInstruction(perpMarketConfig)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

    // TODO: How to get get right anchor typedefs?
    async getRiskAccount(perpMarketConfig: PerpMarketConfig): Promise<any> {
        const marketIndex = perpMarketConfig.marketIndex
        const [riskAccount,_] = await this.deriveRiskAccountAddress(marketIndex)
        return this._program.account.riskParamsAccount.fetch(riskAccount)
    }

    makeSetMaxOpenOrdersInstruction(perpMarketConfig: PerpMarketConfig, maxOpenOrders: number): TransactionInstruction {
        if(maxOpenOrders < 0) {
            throw new Error('Invalid maximum order number')
        }
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.setMaxOpenOrders(new BN(maxOpenOrders), {
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                mangoAccount: this._mangoAccount.publicKey,
                mangoGroup: this._mangoGroup.publicKey,
                mangoProgram: this._mangoClient.programId
            }
        })
    }

    async setMaxOpenOrders(perpMarketConfig: PerpMarketConfig, maxOpenOrders: number): Promise<string> {
        const ix = this.makeSetMaxOpenOrdersInstruction(perpMarketConfig,maxOpenOrders)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

    makeSetMaxLongExposureInstruction(perpMarketConfig: PerpMarketConfig, perpMarket: PerpMarket, maxLongExposure: number | BN, nativeUnits = false): TransactionInstruction {
        if(nativeUnits && !(maxLongExposure instanceof BN)) {
            throw new Error('Native units must use BigNumber (BN)')
        }
        if(!nativeUnits && maxLongExposure instanceof BN) {
            throw new Error('Non-Native units must use Number')
        }
        if(!nativeUnits) {
            maxLongExposure = this.uiToNativeQuantity(perpMarket,maxLongExposure as number)
        }
        maxLongExposure = maxLongExposure as BN
        if(maxLongExposure.ltn(0)) {
            throw new Error('Invalid maximum long exposure')
        }
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.setMaxLongExposure(maxLongExposure, {
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                mangoAccount: this._mangoAccount.publicKey,
                mangoGroup: this._mangoGroup.publicKey,
                mangoProgram: this._mangoClient.programId
            }
        })
    }

    async setMaxLongExposure(perpMarketConfig: PerpMarketConfig, perpMarket: PerpMarket, maxLongExposure: number | BN, nativeUnits = false): Promise<string> {
        const ix = this.makeSetMaxLongExposureInstruction(perpMarketConfig,perpMarket,maxLongExposure,nativeUnits)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

    makeSetMaxShortExposureInstruction(perpMarketConfig: PerpMarketConfig, perpMarket: PerpMarket, maxShortExposure: number | BN, nativeUnits = false): TransactionInstruction {
        if(nativeUnits && !(maxShortExposure instanceof BN)) {
            throw new Error('Native units must use BigNumber (BN)')
        }
        if(!nativeUnits && maxShortExposure instanceof BN) {
            throw new Error('Non-Native units must use Number')
        }
        if(!nativeUnits) {
            maxShortExposure = this.uiToNativeQuantity(perpMarket,maxShortExposure as number)
        }
        maxShortExposure = maxShortExposure as BN
        if(maxShortExposure.ltn(0)) {
            throw new Error('Invalid maximum short exposure')
        }
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.setMaxShortExposure(maxShortExposure, {
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                mangoAccount: this._mangoAccount.publicKey,
                mangoGroup: this._mangoGroup.publicKey,
                mangoProgram: this._mangoClient.programId
            }
        })
    }

    async setMaxShortExposure(perpMarketConfig: PerpMarketConfig, perpMarket: PerpMarket, maxShortExposure: number | BN, nativeUnits = false): Promise<string> {
        const ix = this.makeSetMaxShortExposureInstruction(perpMarketConfig,perpMarket,maxShortExposure,nativeUnits)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

    makeSetViolationBehaviourInstruction(perpMarketConfig: PerpMarketConfig, violationBehaviour: ViolationBehaviour): TransactionInstruction {
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        const enumValue = this.mapViolationBehaviour(violationBehaviour)
        return this._program.instruction.setViolationBehaviour(enumValue, {
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                mangoAccount: this._mangoAccount.publicKey,
                mangoGroup: this._mangoGroup.publicKey,
                mangoProgram: this._mangoClient.programId
            }
        })
    }

    async setViolationBehaviour(perpMarketConfig: PerpMarketConfig,  violationBehaviour: ViolationBehaviour): Promise<string> {
        const ix = this.makeSetViolationBehaviourInstruction(perpMarketConfig,violationBehaviour)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

    makeCheckRiskInstruction(perpMarketConfig: PerpMarketConfig, perpMarket: PerpMarket): TransactionInstruction {
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.checkRisk({
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                mangoAccount: this._mangoAccount.publicKey,
                mangoGroup: this._mangoGroup.publicKey,
                mangoProgram: this._mangoClient.programId,
                perpMarket: perpMarket.publicKey,
                perpMarketBids: perpMarket.bids,
                perpMarketAsks: perpMarket.asks
            }
        })
    }

    makeCloseRiskAccountInstruction(perpMarketConfig: PerpMarketConfig): TransactionInstruction {
        const riskAccount = this.getRiskAccountAddress(perpMarketConfig)
        return this._program.instruction.close({
            accounts: {
                riskParamsAccount: riskAccount,
                authority: this._owner.publicKey,
                systemProgram: SystemProgram.programId
            }
        })
    }

    async closeRiskAccount(perpMarketConfig: PerpMarketConfig): Promise<string> {
        const ix = this.makeCloseRiskAccountInstruction(perpMarketConfig)
        const tx = new Transaction()
        tx.add(ix)
        return await this._program.provider.send(tx)
    }

}

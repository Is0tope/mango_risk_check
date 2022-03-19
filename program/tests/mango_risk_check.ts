import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { MangoRiskCheck } from "../target/types/mango_risk_check";
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { assert, expect } from 'chai'

const RISK_PARAMS_ACCOUNT_SEED_PHRASE = 'risk-check'

const getRiskParamsPDA = async (programID: PublicKey, owner: PublicKey, marketIndex: number): Promise<[PublicKey,number]> => {
  return await PublicKey.findProgramAddress(
    [
      anchor.utils.bytes.utf8.encode(RISK_PARAMS_ACCOUNT_SEED_PHRASE),
      new Uint8Array([marketIndex]),
      anchor.getProvider().wallet.publicKey.toBuffer()
    ],
    programID
  )
}

describe("mango_risk_check", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.Provider.env())

  const program = anchor.workspace.MangoRiskCheck as Program<MangoRiskCheck>
  const marketIndex = 7

  it("Initialising risk params account sets correct settings and default parameters", async () => {
    const wallet = anchor.getProvider().wallet;
    const [riskAccount,bump] = await getRiskParamsPDA(program.programId,wallet.publicKey,marketIndex)
    const tx = await program.rpc.initialize(marketIndex,{
      accounts: {
        authority: wallet.publicKey,
        riskParamsAccount: riskAccount,
        systemProgram: SystemProgram.programId
      }
    })

    const newAcc = await program.account.riskParamsAccount.fetch(riskAccount)

    expect(newAcc.authority.toBase58()).to.equal(wallet.publicKey.toBase58(),'Authority is set to creator')
    expect(newAcc.marketIndex).to.equal(marketIndex,'Market index set correctly')
    expect(newAcc.bump).to.equal(bump,'Bump is set correctly')
    const maxBN = new anchor.BN('ffffffffffffffff',16);
    expect(newAcc.maxLongExposure.eq(maxBN)).to.equal(true,'maximum long position exposure is max BN')
    expect(newAcc.maxShortExposure.eq(maxBN)).to.equal(true,'maximum long position exposure is max BN')
    expect(newAcc.maxOpenOrders.eq(maxBN)).to.equal(true,'maximum open orders is max BN')
    expect(newAcc.maxCapitalAllocated.eq(maxBN)).to.equal(true,'maximum capital allocated is max BN')
  });
});

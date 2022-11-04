import { Transaction } from "@solana/web3.js";

import { WalletNotConnectedError } from "@solana/wallet-adapter-base";

export const getErrorForTransaction = async (connection, txid) => {
    // aguarde toda a confirmação antes de obter a transação
    await connection.confirmTransaction(txid, "max");

    const tx = await connection.getParsedConfirmedTransaction(txid);

    const errors = [];
    if (tx?.meta && tx.meta.logMessages) {
        tx.meta.logMessages.forEach((log) => {
            const regex = /Error: (.*)/gm;
            let m;
            while ((m = regex.exec(log)) !== null) {
                // Isso é necessário para evitar loops infinitos com correspondências de largura zero
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                if (m.length > 1) {
                    errors.push(m[1]);
                }
            }
        });
    }

    return errors;
};

export async function sendTransactionsWithManualRetry(connection, wallet, instructions, signers) {
    let stopPoint = 0;
    let tries = 0;
    let lastInstructionsLength = null;
    let toRemoveSigners = {};
    instructions = instructions.filter((instr, i) => {
        if (instr.length > 0) {
            return true;
        } else {
            toRemoveSigners[i] = true;
            return false;
        }
    });
    let ids = [];
    let filteredSigners = signers.filter((_, i) => !toRemoveSigners[i]);

    while (stopPoint < instructions.length && tries < 3) {
        instructions = instructions.slice(stopPoint, instructions.length);
        filteredSigners = filteredSigners.slice(stopPoint, filteredSigners.length);

        if (instructions.length === lastInstructionsLength) tries = tries + 1;
        else tries = 0;

        try {
            if (instructions.length === 1) {
                const id = await sendTransactionWithRetry(connection, wallet, instructions[0], filteredSigners[0], "single");
                ids.push(id.txid);
                stopPoint = 1;
            } else {
                const { txs } = await sendTransactions(connection, wallet, instructions, filteredSigners, "StopOnFailure", "single");
                ids = ids.concat(txs.map((t) => t.txid));
            }
        } catch (e) {
            console.error(e);
        }
        console.log(
            "Falhou em ",
            stopPoint,
            "tentando novamente da instrução",
            instructions[stopPoint],
            "o comprimento das instruções é",
            instructions.length
        );
        lastInstructionsLength = instructions.length;
    }

    return ids;
}

export const sendTransactions = async (
    connection,
    wallet,
    instructionSet,
    signersSet,
    sequenceType = "Parallel",
    commitment = "singleGossip",
    successCallback = (txid, ind) => {},
    failCallback = (txid, ind) => false,
    block
) => {
    if (!wallet.publicKey) throw new WalletNotConnectedError();

    const unsignedTxns = [];

    if (!block) {
        block = await connection.getRecentBlockhash(commitment);
    }

    for (let i = 0; i < instructionSet.length; i++) {
        const instructions = instructionSet[i];
        const signers = signersSet[i];

        if (instructions.length === 0) {
            continue;
        }

        let transaction = new Transaction();
        instructions.forEach((instruction) => transaction.add(instruction));
        transaction.recentBlockhash = block.blockhash;
        transaction.setSigners(
            // taxa paga pelo proprietário da carteira
            wallet.publicKey,
            ...signers.map((s) => s.publicKey)
        );

        if (signers.length > 0) {
            transaction.partialSign(...signers);
        }

        unsignedTxns.push(transaction);
    }

    const signedTxns = await wallet.signAllTransactions(unsignedTxns);

    const pendingTxns = [];

    let breakEarlyObject = { breakEarly: false, i: 0 };
    console.log("Duração das transações assinadas", signedTxns.length, "vs entregue em comprimento", instructionSet.length);
    for (let i = 0; i < signedTxns.length; i++) {
        const signedTxnPromise = sendSignedTransaction({
            connection,
            signedTransaction: signedTxns[i],
        });

        signedTxnPromise
            .then(({ txid, slot }) => {
                successCallback(txid, i);
            })
            .catch((reason) => {
                failCallback(signedTxns[i], i);
                if (sequenceType === "StopOnFailure") {
                    breakEarlyObject.breakEarly = true;
                    breakEarlyObject.i = i;
                }
            });

        if (sequenceType !== "Parallel") {
            try {
                await signedTxnPromise;
            } catch (e) {
                console.log("Falha detectada", e);
                if (breakEarlyObject.breakEarly) {
                    console.log("Falhou em ", breakEarlyObject.i);
                    // Retornar a transação em que falhamos por índice
                    return {
                        number: breakEarlyObject.i,
                        txs: await Promise.all(pendingTxns),
                    };
                }
            }
        } else {
            pendingTxns.push(signedTxnPromise);
        }
    }

    if (sequenceType !== "Parallel") {
        await Promise.all(pendingTxns);
    }

    return { number: signedTxns.length, txs: await Promise.all(pendingTxns) };
};

export const sendTransaction = async (
    connection,
    wallet,
    instructions,
    signers,
    awaitConfirmation = true,
    commitment = "singleGossip",
    includesFeePayer = false,
    block
) => {
    if (!wallet.publicKey) throw new WalletNotConnectedError();

    let transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (block || (await connection.getRecentBlockhash(commitment))).blockhash;

    if (includesFeePayer) {
        transaction.setSigners(...signers.map((s) => s.publicKey));
    } else {
        transaction.setSigners(
            // taxa paga pelo proprietário da carteira
            wallet.publicKey,
            ...signers.map((s) => s.publicKey)
        );
    }

    if (signers.length > 0) {
        transaction.partialSign(...signers);
    }
    if (!includesFeePayer) {
        transaction = await wallet.signTransaction(transaction);
    }

    const rawTransaction = transaction.serialize();
    let options = {
        skipPreflight: true,
        commitment,
    };

    const txid = await connection.sendRawTransaction(rawTransaction, options);
    let slot = 0;

    if (awaitConfirmation) {
        const confirmation = await awaitTransactionSignatureConfirmation(txid, DEFAULT_TIMEOUT, connection, commitment);

        if (!confirmation) throw new Error("Expirou aguardando confirmação da transação");
        slot = confirmation?.slot || 0;

        if (confirmation?.err) {
            const errors = await getErrorForTransaction(connection, txid);

            console.log(errors);
            throw new Error(`Falha na transação bruta ${txid}`);
        }
    }

    return { txid, slot };
};

export const sendTransactionWithRetry = async (
    connection,
    wallet,
    instructions,
    signers,
    commitment = "singleGossip",
    includesFeePayer = false,
    block,
    beforeSend
) => {
    if (!wallet.publicKey) throw new WalletNotConnectedError();

    let transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (block || (await connection.getRecentBlockhash(commitment))).blockhash;

    if (includesFeePayer) {
        transaction.setSigners(...signers.map((s) => s.publicKey));
    } else {
        transaction.setSigners(
            // taxa paga pelo proprietário da carteira
            wallet.publicKey,
            ...signers.map((s) => s.publicKey)
        );
    }

    if (signers.length > 0) {
        transaction.partialSign(...signers);
    }
    if (!includesFeePayer) {
        transaction = await wallet.signTransaction(transaction);
    }

    if (beforeSend) {
        beforeSend();
    }

    const { txid, slot } = await sendSignedTransaction({
        connection,
        signedTransaction: transaction,
    });

    return { txid, slot };
};

export const getUnixTs = () => {
    return new Date().getTime() / 1000;
};

const DEFAULT_TIMEOUT = 15000;

export async function sendSignedTransaction({ signedTransaction, connection, timeout = DEFAULT_TIMEOUT }) {
    const rawTransaction = signedTransaction.serialize();
    const startTime = getUnixTs();
    let slot = 0;
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
    });

    console.log("Começou aguardando confirmação para", txid);

    let done = false;
    (async () => {
        while (!done && getUnixTs() - startTime < timeout) {
            connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
            });
            await sleep(500);
        }
    })();
    try {
        const confirmation = await awaitTransactionSignatureConfirmation(txid, timeout, connection, "recent", true);

        if (!confirmation) throw new Error("Expirou aguardando confirmação da transação");

        if (confirmation.err) {
            console.error(confirmation.err);
            throw new Error("Falha na transação: erro de instrução personalizada");
        }

        slot = confirmation?.slot || 0;
    } catch (err) {
        console.error("Erro de tempo limite capturado", err);
        if (err.timeout) {
            throw new Error("Expirou aguardando confirmação da transação");
        }
        let simulateResult = null;
        try {
            simulateResult = (await simulateTransaction(connection, signedTransaction, "single")).value;
        } catch (e) {}
        if (simulateResult && simulateResult.err) {
            if (simulateResult.logs) {
                for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
                    const line = simulateResult.logs[i];
                    if (line.startsWith("Log do programa: ")) {
                        throw new Error("Falha na transação: " + line.slice("Log do programa: ".length));
                    }
                }
            }
            throw new Error(JSON.stringify(simulateResult.err));
        }
        // throw new Error('Falha na transação');
    } finally {
        done = true;
    }

    console.log("Latência", txid, getUnixTs() - startTime);
    return { txid, slot };
}

async function simulateTransaction(connection, transaction, commitment) {
    // @ts-ignore
    transaction.recentBlockhash = await connection._recentBlockhash(
        // @ts-ignore
        connection._disableBlockhashCaching
    );

    const signData = transaction.serializeMessage();
    // @ts-ignore
    const wireTransaction = transaction._serialize(signData);
    const encodedTransaction = wireTransaction.toString("base64");
    const config = { encoding: "base64", commitment };
    const args = [encodedTransaction, config];

    // @ts-ignore
    const res = await connection._rpcRequest("simulateTransaction", args);
    if (res.error) {
        throw new Error("falhou ao simular transação: " + res.error.message);
    }
    return res.result;
}

async function awaitTransactionSignatureConfirmation(txid, timeout, connection, commitment = "recent", queryStatus = false) {
    let done = false;
    let status = {
        slot: 0,
        confirmations: 0,
        err: null,
    };
    let subId = 0;
    status = await new Promise(async (resolve, reject) => {
        setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            console.log("Rejeitando por tempo limite...");
            reject({ timeout: true });
        }, timeout);
        try {
            subId = connection.onSignature(
                txid,
                (result, context) => {
                    done = true;
                    status = {
                        err: result.err,
                        slot: context.slot,
                        confirmations: 0,
                    };
                    if (result.err) {
                        console.log("Rejeitado via websocket", result.err);
                        reject(status);
                    } else {
                        console.log("Resolvido via websocket", result);
                        resolve(status);
                    }
                },
                commitment
            );
        } catch (e) {
            done = true;
            console.error("Erro de WS na configuração", txid, e);
        }
        while (!done && queryStatus) {
            // eslint-disable-next-line no-loop-func
            (async () => {
                try {
                    const signatureStatuses = await connection.getSignatureStatuses([txid]);
                    status = signatureStatuses && signatureStatuses.value[0];
                    if (!done) {
                        if (!status) {
                            console.log("REST - resultado nulo para", txid, status);
                        } else if (status.err) {
                            console.log("REST - erro para", txid, status);
                            done = true;
                            reject(status.err);
                        } else if (!status.confirmations) {
                            console.log("REST - sem confirmações para", txid, status);
                        } else {
                            console.log("REST - confirmações para", txid, status);
                            done = true;
                            resolve(status);
                        }
                    }
                } catch (e) {
                    if (!done) {
                        console.log("REST - erro de conexão: txid", txid, e);
                    }
                }
            })();
            await sleep(2000);
        }
    });

    //@ts-ignore
    if (connection._signatureSubscriptions[subId]) connection.removeSignatureListener(subId);
    done = true;
    console.log("Retornando status", status);
    return status;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

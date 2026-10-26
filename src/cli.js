// Local command line to develop without WhatsApp.
//   node src/cli.js seed [myPhone]        reset the demo data (fictional guests)
//   node src/cli.js chat [phone]          talk to the guest agent as that guest
//   node src/cli.js say <phone> <text>    one message, prints the reply
//   node src/cli.js doc <image>           read a document photo (expense agent)
import readline from 'node:readline';
import { handleGuestMessage } from './agents/guest.js';
import { usageTotals } from './meta.js';
import * as store from './store.js';
import { demoSeed } from '../examples/demo-seed.js';

const [, , cmd, ...args] = process.argv;
const showTool = (name, a, r) => console.log(`   ⚙ ${name}(${JSON.stringify(a)}) → ${JSON.stringify(r)}`);

async function main() {
  if (cmd === 'seed') {
    store.reset(demoSeed(args[0]));
    console.log('Demo data reset:', store.load().reservations.map((r) => `${r.id} ${r.guestName} ${r.checkin}`).join(' | '));
  } else if (cmd === 'say') {
    const [phone, ...words] = args;
    const reply = await handleGuestMessage(phone, words.join(' '), { onToolCall: showTool });
    console.log(reply === null ? '(conversation held for the manager)' : `🤖 ${reply}`);
  } else if (cmd === 'chat') {
    const phone = args[0] || '212600000000';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Chat as ${phone}. Empty line to quit.`);
    for await (const line of rl) {
      if (!line.trim()) break;
      const reply = await handleGuestMessage(phone, line, { onToolCall: showTool });
      console.log(reply === null ? '(held for the manager)' : `🤖 ${reply}`);
    }
    rl.close();
  } else if (cmd === 'doc') {
    const { readDocument } = await import('./agents/expense.js');
    console.log(JSON.stringify(await readDocument(args[0]), null, 2));
  } else {
    console.log('Commands: seed | chat | say | doc');
  }
  if (usageTotals.calls) console.log(`\n[Meta API] ${usageTotals.calls} calls, ${usageTotals.input} in / ${usageTotals.output} out tokens`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

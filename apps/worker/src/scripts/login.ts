/**
 * Run ONCE:  npm run tg:login
 *
 * Asks for your phone, the code Telegram sends, and your 2FA password if set.
 * Those never leave your machine.
 *
 * Prints a SESSION STRING. Put it in .env as TG_SESSION.
 * That string is full access to your Telegram account: never commit it,
 * never paste it into a chat.
 */
import input from "input";
import { createClient } from "../lib/telegram.js";

const client = createClient("");

await client.start({
  phoneNumber: async () => await input.text("Phone number (with country code): "),
  password:    async () => await input.text("2FA password (blank if none): "),
  phoneCode:   async () => await input.text("Code Telegram just sent you: "),
  onError:     (err) => console.error(err),
});

const me = await client.getMe();
console.log(`\nLogged in as ${(me as any).firstName ?? ""} (@${(me as any).username ?? "no handle"})`);
console.log("\nPut this in .env as TG_SESSION=\n");
console.log("-".repeat(70));
console.log(client.session.save());
console.log("-".repeat(70));
console.log("\nTreat it like a password.\n");
await client.disconnect();

// Minimal protocol example; replace the response with a call to your own agent.
// This process is trusted code running as your user, not a sandbox.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 100_000) process.exit(1);
}
const request = JSON.parse(input);
if (request.version !== 1 || typeof request.id !== 'string' || typeof request.message !== 'string') process.exit(1);
process.stdout.write(JSON.stringify({ version: 1, id: request.id, text: 'Your adapter is connected. Replace this example response with your agent implementation.' }) + '\n');

// The `input` package ships no types and there is no @types/input on npm.
// Only the prompt helpers the login script uses are declared here.
declare module "input" {
  const input: {
    text(prompt: string): Promise<string>;
    password(prompt: string): Promise<string>;
    confirm(prompt: string): Promise<boolean>;
  };
  export default input;
}

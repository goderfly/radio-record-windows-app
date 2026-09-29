/** Vite resolves `?raw` imports to the file's text; TypeScript needs telling. */
declare module "*?raw" {
  const content: string;
  export default content;
}

export function greet(name: string): string {
  const prefix = "Hello";
<<<<<<< HEAD
  const suffix = "!";
  return `${prefix}, ${name}${suffix}`;
||||||| merged common ancestors
  return prefix + ", " + name;
=======
  return `${prefix}, ${name}.`;
>>>>>>> feature/template-literals
}

export const VERSION = "1.0.0";

<<<<<<< HEAD
export function farewell(name: string): string {
  return `Bye, ${name}`;
}
||||||| merged common ancestors
=======
export function farewell(name: string): string {
  return `Goodbye, ${name}`;
}

export function wave(): string {
  return "o/";
}
>>>>>>> feature/template-literals

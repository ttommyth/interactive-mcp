# Development notes

## Terminal answer submission

`src/components/InteractiveInput.tsx` is shared by the single-question and
intensive-chat UIs. Its nested `TextInput` owns Enter and calls the submit handler;
the parent input listener only changes input mode and option selection. Handling
Enter in both listeners delivers the same answer twice and starts overlapping
writes to the response file.

`pnpm test` builds the sources and exercises the real Ink input components with
terminal streams. It checks that one Enter produces one answer for free text,
empty input, selected options, and switching between options and custom text.

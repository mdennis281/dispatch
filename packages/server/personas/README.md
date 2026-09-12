# Personas

Personas are optional chat roles. They do not select a provider, model, skills, or permission profile.

Definitions are plain markdown files named `<persona-id>.md`, with a level-one heading for the display name and a concise role description below it. `README.md` is documentation and is not listed as a persona.

Dispatch resolves one definition per id: the project's resolved config directory `personas/`, then the global config directory `global/personas/`, then this shipped directory. A project definition replaces the broader definition; bodies are not concatenated. Existing chats store the id, so the latest resolved body is loaded whenever their provider session starts or resumes.

The composer starts with Persona: Off. The `spawn_chat` tool accepts `personaId` for both child and detached chats; omitting it leaves the new chat off even if its parent has a persona. Configuration uses the same quick-action launcher as skills and `config_list/read/write/delete` with `kind: "persona"`. Authoring a definition does not activate it. Persona files need no manifest instruction entry.

Changing the selection retires an idle provider session and resumes its existing transcript on the next message with the new instructions. Changes are refused during an active turn. A missing selected definition produces an actionable error rather than silently running without the requested role.

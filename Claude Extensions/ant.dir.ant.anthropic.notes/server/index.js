#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

async function runAppleScript(script) {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.trim();
  } catch (error) {
    throw new Error(`AppleScript error: ${getErrorMessage(error)}`);
  }
}

const server = new Server(
  {
    name: "Apple-Notes-Server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  return {
    tools: [
      {
        name: "list_notes",
        description: "List all notes from Apple Notes app",
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Optional folder name to filter notes (e.g., 'Notes', 'Recently Deleted')",
            },
            limit: {
              type: "number",
              description: "Maximum number of notes to return (default: 20)",
              default: 20
            },
          },
        },
      },
      {
        name: "get_note_content",
        description: "Get the content of a specific note by its name",
        inputSchema: {
          type: "object",
          properties: {
            note_name: {
              type: "string",
              description: "Name of the note to retrieve",
            },
            folder: {
              type: "string",
              description: "Optional folder name where the note is located",
            },
          },
          required: ["note_name"],
        },
      },
      {
        name: "add_note",
        description: "Create a new note in Apple Notes",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name/title of the new note",
            },
            content: {
              type: "string",
              description: "Content of the new note",
            },
            folder: {
              type: "string",
              description: "Folder to create the note in (default: 'Notes')",
              default: "Notes"
            },
          },
          required: ["name", "content"],
        },
      },
      {
        name: "update_note_content",
        description: "Update the content of an existing note",
        inputSchema: {
          type: "object",
          properties: {
            note_name: {
              type: "string",
              description: "Name of the note to update",
            },
            new_content: {
              type: "string",
              description: "New content for the note",
            },
            folder: {
              type: "string",
              description: "Optional folder name where the note is located",
            },
          },
          required: ["note_name", "new_content"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "list_notes": {
      const folder = request.params.arguments?.folder;
      const limit = Number(request.params.arguments?.limit) || 20;

      let script;
      if (folder) {
        script = `
          tell application "Notes"
            set notesList to {}
            set folderNotes to notes of folder ${JSON.stringify(folder)}
            set noteCount to 0
            repeat with aNote in folderNotes
              if noteCount < ${limit} then
                set noteInfo to "{\\"name\\":\\"" & (name of aNote as string) & "\\",\\"id\\":\\"" & (id of aNote as string) & "\\",\\"creation_date\\":\\"" & (creation date of aNote as string) & "\\",\\"modification_date\\":\\"" & (modification date of aNote as string) & "\\"}"
                set end of notesList to noteInfo
                set noteCount to noteCount + 1
              else
                exit repeat
              end if
            end repeat
            return "[" & my joinList(notesList, ",") & "]"
          end tell
          
          on joinList(theList, delimiter)
            set AppleScript's text item delimiters to delimiter
            set theString to theList as string
            set AppleScript's text item delimiters to ""
            return theString
          end joinList
        `;
      } else {
        script = `
          tell application "Notes"
            set notesList to {}
            set allNotes to notes
            set noteCount to 0
            repeat with aNote in allNotes
              if noteCount < ${limit} then
                set noteInfo to "{\\"name\\":\\"" & (name of aNote as string) & "\\",\\"id\\":\\"" & (id of aNote as string) & "\\",\\"creation_date\\":\\"" & (creation date of aNote as string) & "\\",\\"modification_date\\":\\"" & (modification date of aNote as string) & "\\"}"
                set end of notesList to noteInfo
                set noteCount to noteCount + 1
              else
                exit repeat
              end if
            end repeat
            return "[" & my joinList(notesList, ",") & "]"
          end tell
          
          on joinList(theList, delimiter)
            set AppleScript's text item delimiters to delimiter
            set theString to theList as string
            set AppleScript's text item delimiters to ""
            return theString
          end joinList
        `;
      }

      try {
        const results = await runAppleScript(script);
        return {
          content: [
            {
              type: "text",
              text: results,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to list notes: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "get_note_content": {
      const noteName = String(request.params.arguments?.note_name);
      const folder = request.params.arguments?.folder;

      if (!noteName) {
        throw new Error("Note name is required");
      }

      let script;
      if (folder) {
        script = `
          tell application "Notes"
            set targetNote to first note of folder ${JSON.stringify(folder)} whose name is ${JSON.stringify(noteName)}
            return body of targetNote as string
          end tell
        `;
      } else {
        script = `
          tell application "Notes"
            set targetNote to first note whose name is ${JSON.stringify(noteName)}
            return body of targetNote as string
          end tell
        `;
      }

      try {
        const content = await runAppleScript(script);
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to get note content: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "add_note": {
      const name = String(request.params.arguments?.name);
      const content = String(request.params.arguments?.content);
      const folder = String(request.params.arguments?.folder || "Notes");

      if (!name || !content) {
        throw new Error("Note name and content are required");
      }

      const script = `
        tell application "Notes"
          set targetFolder to folder ${JSON.stringify(folder)}
          set newNote to make new note at targetFolder with properties {name:${JSON.stringify(name)}, body:${JSON.stringify(content)}}
          return "Note created successfully: " & (name of newNote as string)
        end tell
      `;

      try {
        const result = await runAppleScript(script);
        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create note: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "update_note_content": {
      const noteName = String(request.params.arguments?.note_name);
      const newContent = String(request.params.arguments?.new_content);
      const folder = request.params.arguments?.folder;

      if (!noteName || !newContent) {
        throw new Error("Note name and new content are required");
      }

      let script;
      if (folder) {
        script = `
          tell application "Notes"
            set targetNote to first note of folder ${JSON.stringify(folder)} whose name is ${JSON.stringify(noteName)}
            set body of targetNote to ${JSON.stringify(newContent)}
            return "Note updated successfully: " & (name of targetNote as string)
          end tell
        `;
      } else {
        script = `
          tell application "Notes"
            set targetNote to first note whose name is ${JSON.stringify(noteName)}
            set body of targetNote to ${JSON.stringify(newContent)}
            return "Note updated successfully: " & (name of targetNote as string)
          end tell
        `;
      }

      try {
        const result = await runAppleScript(script);
        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to update note: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error("Unknown tool");
  }
});

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Server error:", error);
    process.exit(1);
  }
}

main();
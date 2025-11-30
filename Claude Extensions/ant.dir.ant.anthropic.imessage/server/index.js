#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile, exec } from "child_process";
import { promisify } from "util";
import { access } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const AUTH_TOKEN = process.env.CLAUDE_MCP_TOKEN;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

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

// Helper functions for message reading
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation(operation, retries = MAX_RETRIES, delay = RETRY_DELAY) {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0) {
      console.error(`Operation failed, retrying... (${retries} attempts remaining)`);
      await sleep(delay);
      return retryOperation(operation, retries - 1, delay);
    }
    throw error;
  }
}

function normalizePhoneNumber(phone) {
  // Remove all non-numeric characters except +
  const cleaned = phone.replace(/[^0-9+]/g, '');
  
  // If it's already in the correct format (+1XXXXXXXXXX), return just that
  if (/^\+1\d{10}$/.test(cleaned)) {
    return [cleaned];
  }
  
  // If it starts with 1 and has 11 digits total
  if (/^1\d{10}$/.test(cleaned)) {
    return [`+${cleaned}`];
  }
  
  // If it's 10 digits
  if (/^\d{10}$/.test(cleaned)) {
    return [`+1${cleaned}`];
  }
  
  // If none of the above match, try multiple formats
  const formats = new Set();
  
  if (cleaned.startsWith('+1')) {
    formats.add(cleaned);
  } else if (cleaned.startsWith('1')) {
    formats.add(`+${cleaned}`);
  } else {
    formats.add(`+1${cleaned}`);
  }
  
  return Array.from(formats);
}

async function checkMessagesDBAccess() {
  try {
    const dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
    
    await access(dbPath);
    await execAsync(`sqlite3 "${dbPath}" "SELECT 1;"`);
    
    return true;
  } catch (error) {
    console.error('Error accessing Messages database:', error);
    return false;
  }
}

function decodeAttributedBody(hexString) {
  try {
    // Convert hex to buffer
    const buffer = Buffer.from(hexString, 'hex');
    const content = buffer.toString();
    
    // Common patterns in attributedBody
    const patterns = [
      /NSString">(.*?)</,           // Basic NSString pattern
      /NSString">([^<]+)/,          // NSString without closing tag
      /NSNumber">\d+<.*?NSString">(.*?)</,  // NSNumber followed by NSString
      /NSArray">.*?NSString">(.*?)</,       // NSString within NSArray
      /"string":\s*"([^"]+)"/,      // JSON-style string
      /text[^>]*>(.*?)</,           // Generic XML-style text
      /message>(.*?)</              // Generic message content
    ];
    
    // Try each pattern
    let text = '';
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        text = match[1];
        if (text.length > 5) { // Only use if we got something substantial
          break;
        }
      }
    }
    
    // Look for URLs
    const urlPatterns = [
      /(https?:\/\/[^\s<"]+)/,      // Standard URLs
      /NSString">(https?:\/\/[^\s<"]+)/, // URLs in NSString
      /"url":\s*"(https?:\/\/[^"]+)"/, // URLs in JSON format
      /link[^>]*>(https?:\/\/[^<]+)/ // URLs in XML-style tags
    ];
    
    let url;
    for (const pattern of urlPatterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        url = match[1];
        break;
      }
    }
    
    if (!text && !url) {
      // Try to extract any readable text content
      const readableText = content
        .replace(/streamtyped.*?NSString/g, '') // Remove streamtyped header
        .replace(/NSAttributedString.*?NSString/g, '') // Remove attributed string metadata
        .replace(/NSDictionary.*?$/g, '') // Remove dictionary metadata
        .replace(/\+[A-Za-z]+\s/g, '') // Remove +[identifier] patterns
        .replace(/NSNumber.*?NSValue.*?\*/g, '') // Remove number/value metadata
        .replace(/[^\x20-\x7E]/g, ' ') // Replace non-printable chars with space
        .replace(/\s+/g, ' ')          // Normalize whitespace
        .trim();
      
      if (readableText.length > 5) {    // Only use if we got something substantial
        text = readableText;
      } else {
        return { text: '[Message content not readable]' };
      }
    }

    // Clean up the found text
    if (text) {
      text = text
        .replace(/^[+\s]+/, '') // Remove leading + and spaces
        .replace(/\s*iI\s*[A-Z]\s*$/, '') // Remove iI K pattern at end
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
    }
    
    return { text: text || url || '', url };
  } catch (error) {
    console.error('Error decoding attributedBody:', error);
    return { text: '[Message content not readable]' };
  }
}

async function getAttachmentPaths(messageId) {
  try {
    const query = `
      SELECT filename
      FROM attachment
      INNER JOIN message_attachment_join 
      ON attachment.ROWID = message_attachment_join.attachment_id
      WHERE message_attachment_join.message_id = ${messageId}
    `;
    
    const { stdout } = await execAsync(`sqlite3 -json "${process.env.HOME}/Library/Messages/chat.db" "${query}"`);
    
    if (!stdout.trim()) {
      return [];
    }
    
    const attachments = JSON.parse(stdout);
    return attachments.map(a => a.filename).filter(Boolean);
  } catch (error) {
    console.error('Error getting attachments:', error);
    return [];
  }
}

async function readMessages(phoneNumber, limit = 10) {
  try {
    // Check database access with retries
    const hasAccess = await retryOperation(checkMessagesDBAccess);
    if (!hasAccess) {
      return [];
    }

    // Get all possible formats of the phone number
    const phoneFormats = normalizePhoneNumber(phoneNumber);
    console.error("Trying phone formats:", phoneFormats);
    
    const query = `
      SELECT 
        m.ROWID as message_id,
        CASE 
          WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
          WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
          ELSE NULL
        END as content,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as sender,
        m.is_from_me,
        m.is_audio_message,
        m.cache_has_attachments,
        m.subject,
        CASE 
          WHEN m.text IS NOT NULL AND m.text != '' THEN 0
          WHEN m.attributedBody IS NOT NULL THEN 1
          ELSE 2
        END as content_type
      FROM message m 
      INNER JOIN handle h ON h.ROWID = m.handle_id 
      WHERE h.id IN (${phoneFormats.map(() => '?').join(', ')})
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
        AND m.is_from_me IS NOT NULL  -- Ensure it's a real message
        AND m.item_type = 0  -- Regular messages only
        AND m.is_audio_message = 0  -- Skip audio messages
      ORDER BY m.date DESC 
      LIMIT ${limit}
    `;

    // Execute query with retries
    const { stdout } = await retryOperation(() => 
      execAsync(`sqlite3 -json "${process.env.HOME}/Library/Messages/chat.db" "${query}" ${phoneFormats.map(format => JSON.stringify(format)).join(' ')}`)
    );
    
    if (!stdout.trim()) {
      console.error("No messages found in database for the given phone number");
      return [];
    }

    const messages = JSON.parse(stdout);

    // Process messages with potential parallel attachment fetching
    const processedMessages = await Promise.all(
      messages
        .filter(msg => msg.content !== null || msg.cache_has_attachments === 1)
        .map(async msg => {
          let content = msg.content || '';
          let url;
          
          // If it's an attributedBody (content_type = 1), decode it
          if (msg.content_type === 1) {
            const decoded = decodeAttributedBody(content);
            content = decoded.text;
            url = decoded.url;
          } else {
            // Check for URLs in regular text messages
            const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
            if (urlMatch) {
              url = urlMatch[1];
            }
          }
          
          // Get attachments if any
          let attachments = [];
          if (msg.cache_has_attachments) {
            attachments = await getAttachmentPaths(msg.message_id);
          }
          
          // Add subject if present
          if (msg.subject) {
            content = `Subject: ${msg.subject}\n${content}`;
          }
          
          // Format the message object
          const formattedMsg = {
            content: content || '[No text content]',
            date: new Date(msg.date).toISOString(),
            sender: msg.sender,
            is_from_me: Boolean(msg.is_from_me)
          };

          // Add attachments if any
          if (attachments.length > 0) {
            formattedMsg.attachments = attachments;
            formattedMsg.content += `\n[Attachments: ${attachments.length}]`;
          }

          // Add URL if present
          if (url) {
            formattedMsg.url = url;
            formattedMsg.content += `\n[URL: ${url}]`;
          }

          return formattedMsg;
        })
    );

    return processedMessages;
  } catch (error) {
    console.error('Error reading messages:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
    return [];
  }
}

async function getUnreadMessages(limit = 10) {
  try {
    // Check database access with retries
    const hasAccess = await retryOperation(checkMessagesDBAccess);
    if (!hasAccess) {
      return [];
    }

    const query = `
      SELECT 
        m.ROWID as message_id,
        CASE 
          WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
          WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
          ELSE NULL
        END as content,
        datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        h.id as sender,
        m.is_from_me,
        m.is_audio_message,
        m.cache_has_attachments,
        m.subject,
        CASE 
          WHEN m.text IS NOT NULL AND m.text != '' THEN 0
          WHEN m.attributedBody IS NOT NULL THEN 1
          ELSE 2
        END as content_type
      FROM message m 
      INNER JOIN handle h ON h.ROWID = m.handle_id 
      WHERE m.is_from_me = 0  -- Only messages from others
        AND m.is_read = 0   -- Only unread messages
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
        AND m.is_audio_message = 0  -- Skip audio messages
        AND m.item_type = 0  -- Regular messages only
      ORDER BY m.date DESC 
      LIMIT ${limit}
    `;

    // Execute query with retries
    const { stdout } = await retryOperation(() => 
      execAsync(`sqlite3 -json "${process.env.HOME}/Library/Messages/chat.db" "${query}"`)
    );
    
    if (!stdout.trim()) {
      console.error("No unread messages found");
      return [];
    }

    const messages = JSON.parse(stdout);

    // Process messages with potential parallel attachment fetching
    const processedMessages = await Promise.all(
      messages
        .filter(msg => msg.content !== null || msg.cache_has_attachments === 1)
        .map(async msg => {
          let content = msg.content || '';
          let url;
          
          // If it's an attributedBody (content_type = 1), decode it
          if (msg.content_type === 1) {
            const decoded = decodeAttributedBody(content);
            content = decoded.text;
            url = decoded.url;
          } else {
            // Check for URLs in regular text messages
            const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
            if (urlMatch) {
              url = urlMatch[1];
            }
          }
          
          // Get attachments if any
          let attachments = [];
          if (msg.cache_has_attachments) {
            attachments = await getAttachmentPaths(msg.message_id);
          }
          
          // Add subject if present
          if (msg.subject) {
            content = `Subject: ${msg.subject}\n${content}`;
          }
          
          // Format the message object
          const formattedMsg = {
            content: content || '[No text content]',
            date: new Date(msg.date).toISOString(),
            sender: msg.sender,
            is_from_me: Boolean(msg.is_from_me)
          };

          // Add attachments if any
          if (attachments.length > 0) {
            formattedMsg.attachments = attachments;
            formattedMsg.content += `\n[Attachments: ${attachments.length}]`;
          }

          // Add URL if present
          if (url) {
            formattedMsg.url = url;
            formattedMsg.content += `\n[URL: ${url}]`;
          }

          return formattedMsg;
        })
    );

    return processedMessages;
  } catch (error) {
    console.error('Error reading unread messages:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
    return [];
  }
}

const server = new Server(
  {
    name: "iMessage-AppleScript-Server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  return {
    resources: [
      {
        uri: "contacts://all",
        mimeType: "application/json",
        name: "All Contacts",
        description: "List of all contacts from the Contacts app",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== "contacts://all") {
    throw new Error(`Unknown resource: ${request.params.uri}`);
  }

  const script = `
    tell application "Contacts"
      set output to "["
      repeat with p in every person
        if output is not "[" then
          set output to output & ","
        end if
        set output to output & "{"
        set output to output & "\\"name\\":\\"" & (name of p as text) & "\\","
        set output to output & "\\"phones\\":["
        set firstPhone to true
        repeat with ph in phones of p
          if not firstPhone then
            set output to output & ","
          end if
          set output to output & "\\"" & (value of ph) & "\\""
          set firstPhone to false
        end repeat
        set output to output & "],"
        set output to output & "\\"emails\\":["
        set firstEmail to true
        repeat with em in emails of p
          if not firstEmail then
            set output to output & ","
          end if
          set output to output & "\\"" & (value of em) & "\\""
          set firstEmail to false
        end repeat
        set output to output & "]"
        set output to output & "}"
      end repeat
      return output & "]"
    end tell
  `;

  try {
    const contacts = await runAppleScript(script);
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: contacts,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to fetch contacts: ${getErrorMessage(error)}`);
  }
});

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  return {
    tools: [
      {
        name: "send_imessage",
        description: "Send an iMessage using Messages app",
        inputSchema: {
          type: "object",
          properties: {
            recipient: {
              type: "string",
              description: "Phone number or email of the recipient",
            },
            message: {
              type: "string",
              description: "Message content to send",
            },
          },
          required: ["recipient", "message"],
        },
      },
      {
        name: "search_contacts",
        description: "Search contacts by name, phone, or email",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "read_imessages",
        description: "Read iMessages from a specific contact",
        inputSchema: {
          type: "object",
          properties: {
            phone_number: {
              type: "string",
              description: "Phone number of the contact to read messages from",
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to retrieve (default: 10)",
              default: 10
            },
          },
          required: ["phone_number"],
        },
      },
      {
        name: "get_unread_imessages",
        description: "Get all unread iMessages",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of unread messages to retrieve (default: 10)",
              default: 10
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "send_imessage": {
      const recipient = String(request.params.arguments?.recipient);
      const message = String(request.params.arguments?.message);

      if (!recipient || !message) {
        throw new Error("Recipient and message are required");
      }

      const script = `
        tell application "Messages"
          send ${JSON.stringify(message)} to buddy ${JSON.stringify(recipient)} of (service 1 whose service type = iMessage)
        end tell
      `;

      try {
        await runAppleScript(script);
        return {
          content: [
            {
              type: "text",
              text: `Message sent successfully to ${recipient}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "search_contacts": {
      const query = String(request.params.arguments?.query).toLowerCase();

      const script = `
        tell application "Contacts"
          set output to "["
          set isFirst to true
          repeat with p in every person
            if ((name of p as text) contains ${JSON.stringify(query)}) then
              if not isFirst then
                set output to output & ","
              end if
              set output to output & "{"
              set output to output & "\\"name\\":\\"" & (name of p as text) & "\\","
              set output to output & "\\"phones\\":["
              set firstPhone to true
              repeat with ph in phones of p
                if not firstPhone then
                  set output to output & ","
                end if
                set output to output & "\\"" & (value of ph) & "\\""
                set firstPhone to false
              end repeat
              set output to output & "],"
              set output to output & "\\"emails\\":["
              set firstEmail to true
              repeat with em in emails of p
                if not firstEmail then
                  set output to output & ","
                end if
                set output to output & "\\"" & (value of em) & "\\""
                set firstEmail to false
              end repeat
              set output to output & "]"
              set output to output & "}"
              set isFirst to false
            end if
          end repeat
          return output & "]"
        end tell
      `;

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
              text: `Search failed: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "read_imessages": {
      const phoneNumber = String(request.params.arguments?.phone_number);
      const limit = Number(request.params.arguments?.limit) || 10;

      if (!phoneNumber) {
        throw new Error("Phone number is required");
      }

      // Check database access first
      const hasAccess = await checkMessagesDBAccess();
      if (!hasAccess) {
        return {
          content: [
            {
              type: "text",
              text: 'Cannot access Messages database. To read messages, Claude needs Full Disk Access.\n\n' +
                    'To grant access:\n' +
                    '1. Open System Settings (or System Preferences on older macOS)\n' +
                    '2. Go to Privacy & Security > Privacy\n' +
                    '3. Select "Full Disk Access" from the left sidebar\n' +
                    '4. Click the lock icon and authenticate\n' +
                    '5. Find and enable Claude in the list (or add it with the + button)\n' +
                    '6. Restart Claude for the changes to take effect',
            },
          ],
        };
      }

      try {
        const messages = await readMessages(phoneNumber, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read messages: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "get_unread_imessages": {
      const limit = Number(request.params.arguments?.limit) || 10;

      // Check database access first
      const hasAccess = await checkMessagesDBAccess();
      if (!hasAccess) {
        return {
          content: [
            {
              type: "text",
              text: 'Cannot access Messages database. To read messages, Claude needs Full Disk Access.\n\n' +
                    'To grant access:\n' +
                    '1. Open System Settings (or System Preferences on older macOS)\n' +
                    '2. Go to Privacy & Security > Privacy\n' +
                    '3. Select "Full Disk Access" from the left sidebar\n' +
                    '4. Click the lock icon and authenticate\n' +
                    '5. Find and enable Claude in the list (or add it with the + button)\n' +
                    '6. Restart Claude for the changes to take effect',
            },
          ],
        };
      }

      try {
        const messages = await getUnreadMessages(limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(messages, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to get unread messages: ${getErrorMessage(error)}`,
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

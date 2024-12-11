import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const EXTRA_INSTRUCTIONS: string = core.getInput("EXTRA_INSTRUCTIONS");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  commit_id: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  // Fetch the list of commits in the PR
  const commitsResponse = await octokit.pulls.listCommits({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    per_page: 100,
  });

  // Get the latest commit
  const latestCommit = commitsResponse.data[commitsResponse.data.length - 1];

  // Get the SHA of the latest commit
  const latestCommitSha = latestCommit.sha;
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
    commit_id: latestCommitSha
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}
function createPrompt(file, chunk, prDetails) {
  const diffContent = chunk.changes
    .map((change) => {
      let lineNumber = "";
      if (change.type === "add" || change.type === "del") {
        lineNumber = change.ln ? change.ln.toString() : "";
      } else if (change.type === "normal") {
        lineNumber = change.ln1 ? change.ln1.toString() : "";
      }
      return `${lineNumber} ${change.content}`;
    })
    .join("\n");

  const content = `You are an expert AI code reviewer specializing in Java, Spring, and SQL. You will be provided with a pull request (PR) title, PR description, and the Git diff. Your task is to review the changes in the Git diff and identify potential issues, while demonstrating your in-depth knowledge of Spring.

- Focus exclusively on areas in the code where there might be a problem, but avoid mentioning issues that a compiler would catch, such as incorrect function calls.
- If the code is satisfactory, return an empty array—do not include any positive comments or compliments.
- The PR title and description are for context only and should not be commented on.
- Do not comment on file formatting, linting issues, suggest adding comments, or issues like null values in \`getReferenceById\` which never returns null but throws an exception.
- All comments should be written in GitHub Markdown format.

# Output Format

Return output in JSON format with an array containing comment objects. Each comment object should include:
- \`lineNumber\`: the line number of the issue.
- \`reviewComment\`: details of the concern in GitHub Markdown format.

# Examples

**Input:**
- PR Title: "Fix login retry logic"
- PR Description: "Corrects the retry logic to prevent endless loops."
- Git Diff:
  \`\`\`java
  @@ -10,5 +10,7 @@
  while (currentTry > MAX_TRIES) {
      // retry logic
  }
  \`\`\`

**Output:**
\`\`\`
[
  {
    "lineNumber": 2,
    "reviewComment": "The condition \`currentTry > MAX_TRIES\` is incorrect for the retry logic. It should be \`currentTry < MAX_TRIES\` to limit the number of tries."
  }
]
\`\`\`

(Note: Real examples may vary in length and complexity. Use placeholders to represent the context and structure of comments.)
\``;

  const userMessage = `Please review my PR:

The title is:
${prDetails.title}

The description is: 
---
${prDetails.description}
---

The git diff is:
\`\`\`diff
${chunk.content}
${diffContent}
\`\`\``;

  return [
    {
      role: "system",
      content,
    },
    {
      role: "user",
      content: userMessage,
    },
  ];
}



async function getAIResponse(prompt): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0,
    max_tokens: 1500,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };
  let response: OpenAI.Chat.Completions.ChatCompletion | null = null;
  try {
    response = await openai.chat.completions.create({
      ...queryConfig,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: {
            type: "object",
            properties: {
              reviews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    lineNumber: {
                      type: "integer",
                      description: "The line number being reviewed",
                    },
                    reviewComment: {
                      type: "string",
                      description: "The comment for the review",
                    },
                  },
                  required: ["lineNumber", "reviewComment"],
                  additionalProperties: false,
                },
              },
            },
            required: ["reviews"],
            additionalProperties: false,
          },
        },
      },
      messages: prompt,
    });

    const finish_response = response.choices[0].finish_reason;
    if (finish_response === "length") {
      console.log(
        "The maximum context length has been exceeded. Please reduce the length of the code snippets."
      );
      return null;
    }

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error, response?.choices[0].message?.content);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const aiResponse of aiResponses) {
    const lineNumber = Number(aiResponse.lineNumber);
    if (lineNumber != null) {
      console.log(`Commenting on line ${lineNumber} in file ${file.to}`);
      comments.push({
        body: aiResponse.reviewComment,
        path: file.to!,
        line: lineNumber,
      });
    } else {
      console.error(
          `Line number ${lineNumber} not found in diff for file ${file.to}`
      );
    }
  }
  return comments;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  commit_id: string,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id,
      comments,
      event: "COMMENT",
    });
  } catch (error: any) {
    console.error(`Error creating review comment: ${error}`);
    if (error.status === 422) {
      console.error("One or more comments have invalid positions or lines.");
    }
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened" || eventData.action === "synchronize") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      prDetails.commit_id,
      comments
    );
  } else {
    console.log("No comments to post.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

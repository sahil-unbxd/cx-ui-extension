/**
 * The agentic debugging loop.
 *
 * Instead of one shot ("here is everything we captured, tell me the cause"),
 * the model is handed a toolbox over the still-attached debugger session and
 * investigates: it asks for what it needs, sees the live page, and iterates
 * until it can name a root cause. This is what makes the extension behave like
 * an MCP server rather than a form submission — with the difference that it is
 * driving the engineer's own logged-in browser.
 *
 * The loop is bounded: a hard iteration cap, a wall-clock budget, and
 * size-capped tool results (enforced in toolbox.js), so a confused model
 * cannot spend the engineer's tokens indefinitely.
 */
import { completeWithTools } from './client.js';
import { AGENT_PREAMBLE } from '../prompt/templates.js';

const MAX_ITERATIONS = 12;
const MAX_WALL_MS = 120_000;


/**
 * @param {object} args
 * @param {object} args.toolbox  from createToolbox()
 * @param {function} [args.onStep] called with each {type, ...} event for live UI
 * @returns {{text, steps, iterations, usage, stoppedBecause}}
 */
export async function runAgentLoop({
  provider,
  model,
  apiKey,
  system,
  user,
  toolbox,
  onStep = () => {},
  maxIterations = MAX_ITERATIONS,
  signal
}) {
  const messages = [{ role: 'user', text: user }];
  const steps = [];
  const usageTotals = { input: 0, output: 0 };
  const startedAt = Date.now();

  let finalText = '';
  let stoppedBecause = 'completed';
  let iterations = 0;
  let lastModel = model;

  while (iterations < maxIterations) {
    iterations += 1;

    const turn = await completeWithTools({
      provider,
      model,
      apiKey,
      system: `${system}\n${AGENT_PREAMBLE}`,
      messages,
      tools: toolbox.definitions,
      signal
    });

    lastModel = turn.model || lastModel;
    accumulateUsage(usageTotals, turn.usage);

    if (turn.text) {
      steps.push({ type: 'thought', text: turn.text });
      onStep({ type: 'thought', text: turn.text });
    }

    if (!turn.toolCalls.length) {
      finalText = turn.text;
      break;
    }

    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

    const toolResults = [];
    for (const call of turn.toolCalls) {
      onStep({ type: 'tool_start', name: call.name, input: call.input });
      const result = await toolbox.run(call.name, call.input);
      const content = JSON.stringify(result);
      steps.push({ type: 'tool', name: call.name, input: call.input, result });
      onStep({ type: 'tool_end', name: call.name, result });
      toolResults.push({ id: call.id, content });
    }
    messages.push({ role: 'user', toolResults });

    if (Date.now() - startedAt > MAX_WALL_MS) {
      stoppedBecause = 'time_budget';
      break;
    }
  }

  if (!finalText) {
    if (stoppedBecause === 'completed') stoppedBecause = 'iteration_cap';
    // Ask once for a conclusion from what it already has, rather than
    // returning an empty answer after spending the budget.
    const wrapUp = await completeWithTools({
      provider,
      model,
      apiKey,
      system: `${system}\n${AGENT_PREAMBLE}`,
      messages: [
        ...messages,
        {
          role: 'user',
          text: `Investigation budget reached (${stoppedBecause}). Give your best answer now from the evidence gathered, in the required markdown structure, with no further tool calls. If the evidence is inconclusive, say so and state what to capture next.`
        }
      ],
      tools: [],
      signal
    });
    accumulateUsage(usageTotals, wrapUp.usage);
    finalText = wrapUp.text;
  }

  return {
    text: finalText,
    steps,
    iterations,
    stoppedBecause,
    model: lastModel,
    usage: { input_tokens: usageTotals.input, output_tokens: usageTotals.output }
  };
}

function accumulateUsage(totals, usage) {
  if (!usage) return;
  totals.input += usage.input_tokens ?? usage.prompt_tokens ?? 0;
  totals.output += usage.output_tokens ?? usage.completion_tokens ?? 0;
}

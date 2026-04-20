import { createAiGateway } from "ai-gateway-provider";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { streamText, Output } from "ai";
import { z } from "zod";

interface StreamProxyOptions {
  accountId: string;
  gateway: string;
  aigToken: string;
  model: string;
  maxOutputTokens: number;
  systemPrompt: string;
  userMessage: string;
  outputSchema: z.ZodType;
  corsHeaders: Record<string, string>;
}

interface StreamResult {
  response: Response;
  /** Resolves with the accumulated text and usage after the stream ends. */
  completion: Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export function createStreamingProxy(options: StreamProxyOptions): StreamResult {
  const { accountId, gateway, aigToken, model, maxOutputTokens, systemPrompt, userMessage, outputSchema, corsHeaders } = options;

  const aigateway = createAiGateway({ accountId, gateway, apiKey: aigToken });
  const anthropic = createAnthropic();
  const modelId = model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;

  console.log("[stream] REQUEST", JSON.stringify({
    model: modelId,
    max_tokens: maxOutputTokens,
    system_length: systemPrompt.length,
    user_message_length: userMessage.length,
    user_message_preview: userMessage.slice(0, 500),
  }));

  let resolveCompletion: (value: { text: string; inputTokens: number; outputTokens: number }) => void;
  let rejectCompletion: (err: Error) => void;
  const completion = new Promise<{ text: string; inputTokens: number; outputTokens: number }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const readable = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();

      try {
        const result = streamText({
          model: aigateway(anthropic(modelId)),
          output: Output.object({ schema: outputSchema }),
          system: systemPrompt,
          prompt: userMessage,
          maxOutputTokens,
        });

        let accumulatedText = "";
        let inputTokens = 0;
        let outputTokens = 0;

        for await (const chunk of result.fullStream) {
          if (chunk.type === "text-delta") {
            accumulatedText += chunk.text;
            const event = {
              type: "content_block_delta",
              delta: { type: "text_delta", text: chunk.text },
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          } else if (chunk.type === "finish") {
            inputTokens = chunk.totalUsage.inputTokens ?? 0;
            outputTokens = chunk.totalUsage.outputTokens ?? 0;
          } else if (chunk.type === "error") {
            throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
          }
        }

        controller.close();
        console.log("[stream] RESPONSE", JSON.stringify({
          inputTokens,
          outputTokens,
          text_length: accumulatedText.length,
          text_preview: accumulatedText.slice(0, 1000),
        }));
        resolveCompletion!({ text: accumulatedText, inputTokens, outputTokens });
      } catch (err) {
        controller.error(err);
        rejectCompletion!(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  const response = new Response(readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });

  return { response, completion };
}

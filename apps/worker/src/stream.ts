interface StreamProxyOptions {
  gatewayUrl: string;
  apiKey: string;
  aigToken: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userMessage: string;
  outputSchema: unknown;
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
  const {
    gatewayUrl,
    apiKey,
    aigToken,
    model,
    maxTokens,
    systemPrompt,
    userMessage,
    outputSchema,
    corsHeaders,
  } = options;

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: outputSchema },
  });

  console.log("[stream] REQUEST", JSON.stringify({
    model,
    max_tokens: maxTokens,
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
      try {
        const resp = await fetch(gatewayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "structured-outputs-2025-11-13",
            "cf-aig-authorization": `Bearer ${aigToken}`,
          },
          body,
        });

        if (!resp.ok || !resp.body) {
          const errText = await resp.text();
          console.log("[stream] ERROR", resp.status, errText.slice(0, 500));
          controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ status: resp.status, error: errText })}\n\n`));
          controller.close();
          rejectCompletion!(new Error(`Anthropic ${resp.status}: ${errText.slice(0, 200)}`));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedText = "";
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Forward raw SSE chunk to client
          controller.enqueue(value);

          // Parse SSE events from chunk to accumulate text
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              if (event.type === "content_block_delta" && event.delta?.text) {
                accumulatedText += event.delta.text;
              }
              if (event.type === "message_delta" && event.usage) {
                outputTokens = event.usage.output_tokens ?? outputTokens;
              }
              if (event.type === "message_start" && event.message?.usage) {
                inputTokens = event.message.usage.input_tokens ?? inputTokens;
              }
            } catch {
              // Not all lines are JSON — ignore
            }
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

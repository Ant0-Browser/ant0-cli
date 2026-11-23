/** Thrown by the text parsers (proxy lines/URLs, cookies, CSV) on malformed input. */
export class ParseError extends Error {
  override readonly name = "ParseError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

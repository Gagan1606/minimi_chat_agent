export interface ModelProvider {
  generate(prompt: string, systemInstruction?: string): Promise<string>;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

export interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

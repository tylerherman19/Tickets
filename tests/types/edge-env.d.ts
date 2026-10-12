/** Minimal runtime surface for offline type checking; no deployed runtime mocks. */
declare const Deno: {
 env: { get(name:string): string|undefined };
 serve(handler:(req:Request)=>Response|Promise<Response>):unknown;
};

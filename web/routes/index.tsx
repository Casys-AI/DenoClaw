/** Redirect / → /overview */
export const handler = {
  GET(_req: Request) {
    return new Response(null, {
      status: 307,
      headers: { location: "/overview" },
    });
  },
};

export default function Index() {
  return null;
}

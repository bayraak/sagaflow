# with-valibot

The same saga, validated by Valibot instead of Zod.

```bash
bun test examples/with-valibot
```

sagaflow never imports either one. Validation is [Standard Schema](https://standardschema.dev), so
a schema is anything carrying a `~standard` property — Zod, Valibot, ArkType, Effect Schema. Bring
the one you already have; change your mind later by changing the schema and nothing else.

That is also why the package has zero runtime dependencies: it never needed a validator of its
own, only an agreement about what one looks like.

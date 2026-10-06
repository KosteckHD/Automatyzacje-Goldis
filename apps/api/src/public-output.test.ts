import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { BadRequestException, Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { PublicExceptionFilter, PublicOutputInterceptor, sanitizePublicFileName, sanitizePublicOutput } from "./public-output";

const syntheticPesel = "12345678901";

@Controller("public-output-test")
class PublicOutputController {
  @Get("payload") payload() {
    return {
      companyName: `Synthetic ${syntheticPesel}`,
      person: { pesel: syntheticPesel, name: "Synthetic Person" },
      path: "C:\\private\\input.xlsx",
      storageKey: "runs/private.xlsx",
      fileName: "C:\\Users\\synthetic\\12345678901.xlsx",
      nested: { filePath: "/srv/goldis/private.xlsx", note: "Keep this label" },
    };
  }

  @Get("bad-request") badRequest(): never {
    throw new BadRequestException(`Niepoprawne dane ${syntheticPesel} z C:\\private\\input.xlsx`);
  }

  @Get("internal-error") internalError(): never {
    throw new Error(`database path /srv/goldis/private ${syntheticPesel}`);
  }
}

@Module({
  controllers: [PublicOutputController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: PublicOutputInterceptor },
    { provide: APP_FILTER, useClass: PublicExceptionFilter },
  ],
})
class PublicOutputHttpTestModule {}

test("public JSON usuwa PESEL i ścieżki oraz maskuje ich wystąpienia w tekście", () => {
  const output = sanitizePublicOutput({
    pesel: syntheticPesel,
    nested: { absolutePath: "C:\\private\\artifact.xlsx", text: `Person ${syntheticPesel}` },
    unchanged: "Synthetic label",
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(syntheticPesel), false);
  assert.equal(serialized.includes("C:\\private"), false);
  assert.equal("pesel" in output, false);
  assert.deepEqual(output.nested, { text: "Person [ukryto]" });
  assert.equal(output.unchanged, "Synthetic label");
  assert.equal(sanitizePublicFileName("C:\\temp\\12345678901.xlsx"), "[ukryto].xlsx");
});

test("globalny interceptor i filter nie zwracają PESEL-i, ścieżek ani błędów wewnętrznych", async () => {
  const app = await NestFactory.create(PublicOutputHttpTestModule, { logger: false });
  try {
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const root = `http://127.0.0.1:${address.port}/api/public-output-test`;

    const payloadResponse = await fetch(`${root}/payload`);
    assert.equal(payloadResponse.status, 200);
    const payloadText = await payloadResponse.text();
    assert.equal(payloadText.includes(syntheticPesel), false);
    assert.equal(payloadText.includes("C:\\Users"), false);
    assert.equal(payloadText.includes("/srv/goldis"), false);
    assert.equal(payloadText.includes('"pesel"'), false);
    assert.equal(payloadText.includes('"filePath"'), false);
    assert.match(payloadText, /Keep this label/);

    const badRequest = await fetch(`${root}/bad-request`);
    assert.equal(badRequest.status, 400);
    const badRequestText = await badRequest.text();
    assert.equal(badRequestText.includes(syntheticPesel), false);
    assert.equal(badRequestText.includes("C:\\private"), false);

    const internalError = await fetch(`${root}/internal-error`);
    assert.equal(internalError.status, 500);
    const internalErrorText = await internalError.text();
    assert.equal(internalErrorText.includes(syntheticPesel), false);
    assert.equal(internalErrorText.includes("/srv/goldis"), false);
    assert.equal(internalErrorText.includes("database path"), false);
    assert.match(internalErrorText, /Wystąpił błąd serwera/);
  } finally {
    await app.close();
  }
});

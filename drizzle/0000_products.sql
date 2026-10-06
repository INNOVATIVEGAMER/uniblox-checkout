CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_paise" bigint NOT NULL,
	"stock" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_paise_nonneg" CHECK ("products"."price_paise" >= 0),
	CONSTRAINT "products_stock_nonneg" CHECK ("products"."stock" >= 0)
);

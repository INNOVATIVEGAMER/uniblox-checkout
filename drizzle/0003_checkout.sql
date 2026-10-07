CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"order_id" uuid,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "idempotency_keys_response_pair" CHECK (("idempotency_keys"."response_status" IS NULL) = ("idempotency_keys"."response_body" IS NULL)),
	CONSTRAINT "idempotency_keys_one_replay_source" CHECK ("idempotency_keys"."order_id" IS NULL OR "idempotency_keys"."response_status" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"order_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_paise" bigint NOT NULL,
	CONSTRAINT "order_items_order_id_product_id_pk" PRIMARY KEY("order_id","product_id"),
	CONSTRAINT "order_items_quantity_range" CHECK ("order_items"."quantity" BETWEEN 1 AND 1000),
	CONSTRAINT "order_items_line_total_formula" CHECK ("order_items"."line_total_paise" = "order_items"."unit_price_paise" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"payment_ref" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" IN ('pending_payment', 'paid', 'failed')),
	CONSTRAINT "orders_total_nonneg" CHECK ("orders"."total_paise" >= 0),
	CONSTRAINT "orders_total_formula" CHECK ("orders"."total_paise" = "orders"."subtotal_paise" - "orders"."discount_paise"),
	CONSTRAINT "orders_resolved_iff_not_pending" CHECK (("orders"."status" = 'pending_payment') = ("orders"."resolved_at" IS NULL)),
	CONSTRAINT "orders_failure_reason_iff_failed" CHECK (("orders"."status" = 'failed') = ("orders"."failure_reason" IS NOT NULL)),
	CONSTRAINT "orders_paid_has_payment_ref" CHECK ("orders"."status" <> 'paid' OR "orders"."total_paise" = 0 OR "orders"."payment_ref" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_live_cart_uq" ON "orders" USING btree ("cart_id") WHERE "orders"."status" <> 'failed';
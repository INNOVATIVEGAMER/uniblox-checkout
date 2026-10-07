CREATE TABLE "cart_items" (
	"cart_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "cart_items_cart_id_product_id_pk" PRIMARY KEY("cart_id","product_id"),
	CONSTRAINT "cart_items_quantity_range" CHECK ("cart_items"."quantity" BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_status_valid" CHECK ("carts"."status" IN ('open', 'pending_payment', 'checked_out'))
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
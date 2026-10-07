CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"milestone" integer NOT NULL,
	"percent_off" integer NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "coupons_code_unique" UNIQUE("code"),
	CONSTRAINT "coupons_milestone_unique" UNIQUE("milestone"),
	CONSTRAINT "coupons_status_valid" CHECK ("coupons"."status" IN ('available', 'reserved', 'redeemed')),
	CONSTRAINT "coupons_percent_off_range" CHECK ("coupons"."percent_off" BETWEEN 1 AND 100),
	CONSTRAINT "coupons_redeemed_at_iff_redeemed" CHECK (("coupons"."status" = 'redeemed') = ("coupons"."redeemed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "percent_off" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_live_coupon_uq" ON "orders" USING btree ("coupon_id") WHERE "orders"."status" <> 'failed';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_formula" CHECK ("orders"."discount_paise" = COALESCE("orders"."subtotal_paise" * "orders"."percent_off" / 100, 0));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_percent_pair" CHECK (("orders"."coupon_id" IS NULL) = ("orders"."percent_off" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_percent_off_range" CHECK ("orders"."percent_off" BETWEEN 1 AND 100);
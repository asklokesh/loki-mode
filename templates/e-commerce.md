# PRD: E-Commerce Storefront

## Overview
A simple e-commerce storefront called "ShopBase" with a product catalog, shopping cart, checkout flow, and Stripe payment processing. Designed as a single-vendor store selling physical or digital products.

## Target Users
- Small business owners selling products online
- Indie makers selling digital goods (templates, courses, ebooks)
- Developers learning e-commerce patterns

## Features

### MVP Features
1. **Product Catalog** - Browse products with images, prices, descriptions, and categories
2. **Product Detail** - Full product page with image gallery and variants (size/color)
3. **Shopping Cart** - Add/remove items, update quantities, persistent cart (survives refresh)
4. **Checkout** - Shipping address form, order summary, Stripe payment
5. **Order Confirmation** - Confirmation page and email receipt
6. **Order History** - View past orders and their status (for logged-in users)
7. **Admin Panel** - Product CRUD, order management, basic revenue dashboard
8. **Search and Filter** - Search by name, filter by category and price range

### User Flow (Shopper)
1. Visits homepage -> sees featured products and categories
2. Browses category -> filters by price range
3. Clicks product -> sees details, selects variant, adds to cart
4. Opens cart -> adjusts quantities -> proceeds to checkout
5. Enters shipping info -> reviews order -> pays with card via Stripe
6. Sees order confirmation -> receives email receipt
7. Can view order status in account page

### User Flow (Admin)
1. Logs into /admin
2. Adds new product with images, price, variants, and category
3. Views orders list, updates order status (processing -> shipped -> delivered)
4. Checks revenue dashboard for daily/weekly/monthly totals

## Tech Stack

### Frontend
- Next.js 14 (App Router)
- TypeScript
- TailwindCSS + shadcn/ui
- Zustand for cart state (persisted to localStorage)
- React Hook Form + zod for checkout form

### Backend
- Next.js API Routes
- Prisma ORM
- PostgreSQL (local via Docker for dev)
- Stripe SDK (Checkout Sessions + Webhooks)
- Resend or Nodemailer for order confirmation emails

### Structure
```
/
├── src/
│   ├── app/
│   │   ├── page.tsx                      # Homepage
│   │   ├── products/
│   │   │   ├── page.tsx                  # Product listing
│   │   │   └── [slug]/
│   │   │       └── page.tsx              # Product detail
│   │   ├── cart/
│   │   │   └── page.tsx                  # Shopping cart
│   │   ├── checkout/
│   │   │   ├── page.tsx                  # Checkout form
│   │   │   └── success/
│   │   │       └── page.tsx              # Order confirmation
│   │   ├── account/
│   │   │   ├── page.tsx                  # Account overview
│   │   │   ├── orders/
│   │   │   │   └── page.tsx              # Order history
│   │   │   └── orders/[id]/
│   │   │       └── page.tsx              # Order detail
│   │   ├── auth/
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   └── signup/
│   │   │       └── page.tsx
│   │   ├── admin/
│   │   │   ├── page.tsx                  # Admin dashboard
│   │   │   ├── products/
│   │   │   │   ├── page.tsx              # Product management
│   │   │   │   └── [id]/
│   │   │   │       └── edit/
│   │   │   │           └── page.tsx      # Edit product
│   │   │   └── orders/
│   │   │       └── page.tsx              # Order management
│   │   ├── api/
│   │   │   ├── products/
│   │   │   │   └── route.ts
│   │   │   ├── orders/
│   │   │   │   └── route.ts
│   │   │   ├── checkout/
│   │   │   │   └── route.ts
│   │   │   ├── webhooks/
│   │   │   │   └── stripe/
│   │   │   │       └── route.ts
│   │   │   └── auth/
│   │   │       └── [...nextauth]/
│   │   │           └── route.ts
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ProductCard.tsx
│   │   ├── ProductGallery.tsx
│   │   ├── VariantSelector.tsx
│   │   ├── CartItem.tsx
│   │   ├── CartSummary.tsx
│   │   ├── CheckoutForm.tsx
│   │   ├── OrderStatusBadge.tsx
│   │   ├── PriceDisplay.tsx
│   │   ├── SearchBar.tsx
│   │   ├── CategoryNav.tsx
│   │   ├── PriceFilter.tsx
│   │   └── admin/
│   │       ├── ProductForm.tsx
│   │       ├── OrderTable.tsx
│   │       └── RevenueChart.tsx
│   ├── stores/
│   │   └── cartStore.ts
│   ├── lib/
│   │   ├── db.ts
│   │   ├── stripe.ts
│   │   ├── auth.ts
│   │   ├── email.ts
│   │   └── format.ts                    # Currency, date formatting
│   └── types/
│       └── index.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                          # Seed sample products
├── public/
│   └── uploads/                         # Product images
├── tests/
│   ├── cart.test.ts
│   ├── checkout.test.ts
│   ├── api/
│   │   ├── products.test.ts
│   │   └── orders.test.ts
│   └── components/
│       ├── ProductCard.test.tsx
│       └── CartSummary.test.tsx
├── package.json
├── tsconfig.json
└── README.md
```

## Database Schema

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  name         String?
  passwordHash String?
  role         UserRole @default(CUSTOMER)
  createdAt    DateTime @default(now())

  orders Order[]
}

model Product {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  description String
  price       Int                          // Price in cents
  compareAt   Int?                         // Original price for sale display
  images      String                       // JSON array of image URLs
  categoryId  String?
  inStock     Boolean  @default(true)
  featured    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  category Category? @relation(fields: [categoryId], references: [id])
  variants Variant[]
  orderItems OrderItem[]
}

model Variant {
  id        String  @id @default(cuid())
  productId String
  name      String                         // "Size" or "Color"
  value     String                         // "Large" or "Blue"
  priceAdj  Int     @default(0)            // Price adjustment in cents
  sku       String?
  inStock   Boolean @default(true)

  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  orderItems OrderItem[]
}

model Category {
  id          String  @id @default(cuid())
  name        String
  slug        String  @unique
  description String?

  products Product[]
}

model Order {
  id              String      @id @default(cuid())
  userId          String?
  email           String
  status          OrderStatus @default(PENDING)
  subtotal        Int                        // In cents
  shipping        Int         @default(0)
  tax             Int         @default(0)
  total           Int
  stripeSessionId String?     @unique
  stripePaymentId String?

  shippingName    String
  shippingAddress String
  shippingCity    String
  shippingState   String
  shippingZip     String
  shippingCountry String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user  User?       @relation(fields: [userId], references: [id])
  items OrderItem[]
}

model OrderItem {
  id        String @id @default(cuid())
  orderId   String
  productId String
  variantId String?
  quantity  Int
  price     Int                            // Price at time of purchase (cents)

  order   Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id])
  variant Variant? @relation(fields: [variantId], references: [id])
}

enum UserRole {
  CUSTOMER
  ADMIN
}

enum OrderStatus {
  PENDING
  PAID
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELED
  REFUNDED
}
```

## API Endpoints

### Products
- `GET /api/products` - List products (query: `?category=`, `?search=`, `?minPrice=`, `?maxPrice=`, `?featured=`, `?page=`)
- `GET /api/products/:slug` - Get product detail with variants
- `POST /api/products` - Create product (admin only)
- `PUT /api/products/:id` - Update product (admin only)
- `DELETE /api/products/:id` - Delete product (admin only)

### Cart (client-side only)
- Cart is managed entirely in Zustand store with localStorage persistence
- No server-side cart API needed for MVP

### Checkout
- `POST /api/checkout` - Create Stripe Checkout Session (receives cart items + shipping info)
- `POST /api/webhooks/stripe` - Handle Stripe webhooks (checkout.session.completed, payment_intent.succeeded, charge.refunded)

### Orders
- `GET /api/orders` - List orders for current user (or all for admin)
- `GET /api/orders/:id` - Get order detail
- `PATCH /api/orders/:id` - Update order status (admin only)

### Auth
- NextAuth.js credentials provider (email/password)
- `GET /api/auth/session` - Get current session

## Requirements
- TypeScript throughout
- All prices stored and calculated in cents (avoid floating point)
- Currency display formatted with Intl.NumberFormat
- Product images: max 5 per product, max 5MB each
- Cart persists in localStorage, validates stock on checkout
- Stripe Checkout handles PCI compliance (no card data on our server)
- Stripe webhook signature verification on all webhook handlers
- Order confirmation email sent after successful payment
- SEO: product pages have Open Graph tags for social sharing
- Responsive design (mobile shopping experience is critical)
- Seed script creates 10+ sample products across 3-4 categories

## Testing
- Unit tests: Cart store (add, remove, quantity, total calculation), price formatting (Vitest)
- API tests: Product CRUD, checkout session creation, order status updates
- Integration tests: Full checkout flow with Stripe test mode
- Component tests: ProductCard, CartSummary, CheckoutForm rendering
- Stripe: Use `stripe listen --forward-to localhost:3000/api/webhooks/stripe` for webhook testing

## Out of Scope
- Inventory management (stock quantity tracking)
- Tax calculation service (Stripe Tax or TaxJar)
- Shipping rate calculation (flat rate only)
- Discount codes / coupons
- Product reviews / ratings
- Wishlist
- Multi-currency support
- Email marketing integration
- Analytics / conversion tracking
- Production deployment

## Success Criteria
- Product catalog displays with images, prices, and categories
- Filtering by category and price range works
- Cart add/remove/quantity update works and persists across page refresh
- Checkout creates a Stripe Checkout Session and redirects correctly
- Stripe webhook processes payment and creates order in database
- Order confirmation page shows correct order details
- Order history shows all past orders for logged-in users
- Admin can create/edit products and update order status
- Revenue dashboard shows accurate totals
- Seed data provides a realistic browsing experience
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build a complete e-commerce application with payment processing, order management, and an admin interface. Expect ~60-90 minutes for full execution.
